import path from 'node:path'
import process from 'node:process'
import fs from 'fs-extra'
import { LockError, toError } from '../errors'
import { t } from '../i18n'
import { logger } from '../logger'

export const REPO_LOCK_FILE = 'sync-upstream.lock'

/**
 * Two syncs sharing one working tree corrupt each other: they interleave `checkout`,
 * `git rm`, index writes and commits, and both push. A webhook delivery and a manual run
 * are the everyday way to end up there, so the exclusion has to survive process boundaries.
 *
 * `O_EXCL` create is atomic on Linux, macOS and Windows, which makes the lock file itself
 * the mutual-exclusion primitive — no external daemon, no advisory `flock` portability trap.
 */
export interface LockHandle {
  /** Absolute path of the lock file, for diagnostics. */
  readonly file: string
  release: () => Promise<void>
  /** Throws if another process took the lock over while this one was running. */
  ensureHeld: () => Promise<void>
}

export interface LockRecord {
  pid: number
  /** Random per acquisition so a release never deletes somebody else's lock. */
  token: string
  label: string
  createdAt: number
}

export interface RepoLockOptions {
  /** `.git` directory the lock lives in. */
  gitDir: string
  label?: string
  /** Total time to keep trying before giving up. 0 (default) fails on the first clash. */
  waitMs?: number
  pollMs?: number
  /**
   * Age at which a lock is taken over even when its holder still looks alive (a pid reused
   * by another process, or a lock written on a machine with a different pid namespace).
   * A lock whose holder is provably dead is taken over immediately — nobody should have to
   * wait half an hour after a crash.
   */
  staleAfterMs?: number
  /** Test seam. */
  now?: () => number
  /** Test seam. */
  isPidAlive?: (pid: number) => boolean
}

const DEFAULT_POLL_MS = 200
/** Age at which a lock is reclaimed even if its pid still looks alive. */
export const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
  })
}

/** Whether a pid still names a live process (EPERM = alive but owned by somebody else). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0)
    return false
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    // EPERM means the pid exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function lockPathFor(gitDir: string): string {
  return path.join(gitDir, REPO_LOCK_FILE)
}

function readFileLock(file: string): Promise<LockRecord | null> {
  return fs.readFile(file, 'utf8')
    .then((content) => {
      try {
        return JSON.parse(content) as LockRecord
      }
      catch {
        return unknownHolder(file)
      }
    })
    .catch(() => null)
}

/**
 * A lock we cannot read is still a lock: another process may have been pre-empted between
 * `open(O_EXCL)` and its first `write`, so the file is legitimately empty right now. We
 * therefore report an unknown holder (which only ages out) instead of treating the
 * unreadable bytes as an abandoned lock and stealing a live one.
 */
async function unknownHolder(file: string): Promise<LockRecord> {
  const created = await fs.stat(file).then(stat => stat.mtimeMs, () => Number.NaN)
  return { pid: -1, token: 'unparseable', label: 'unreadable', createdAt: created }
}

/** Chains tasks per lock file so two deliveries in this process cannot run at once. */
const chains = new Map<string, Promise<void>>()

function withinProcess<T>(file: string, task: () => Promise<T>): Promise<T> {
  const previous = chains.get(file) ?? Promise.resolve()
  const settled = previous.then(task, task)
  // The queued tail outlives `settled` and clears the map entry once the queue drains,
  // so a rejected sync never wedges later deliveries behind a dead promise.
  const tail: Promise<void> = settled.then(() => undefined, () => undefined).then(() => {
    if (chains.get(file) === tail)
      chains.delete(file)
  })
  chains.set(file, tail)
  return settled
}

/**
 * Acquire the repository lock. Resolves once the caller owns it; the returned handle must
 * be released (a crash is tolerated — the stale rules clean up afterwards).
 */
export async function acquireRepoLock(options: RepoLockOptions): Promise<LockHandle> {
  const file = lockPathFor(options.gitDir)
  const now = options.now ?? (() => Date.now())
  const pidAlive = options.isPidAlive ?? isProcessAlive
  const staleAfter = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
  const deadline = now() + (options.waitMs ?? 0)
  const token = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`
  const started = now()

  for (;;) {
    const record: LockRecord = {
      pid: process.pid,
      token,
      label: options.label ?? 'sync',
      createdAt: now(),
    }

    try {
      await fs.outputFile(file, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' })
      return handleFor(file, token, options.gitDir)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw new LockError(t('e.lockCreateFailed', { file }), toError(error), { gitDir: options.gitDir })
    }

    const existing = await readFileLock(file)
    if (existing && isStale(existing, now(), pidAlive, staleAfter)) {
      logger.warn(t('e.lockStaleTakeover', { pid: existing.pid, seconds: Math.round(staleAfter / 1000), file }))
      await fs.remove(file).catch(() => undefined)
      // Reclaim it immediately instead of letting another waiter win the race and then
      // reporting "still locked" for a lock we just deleted.
      if (await steal(file, record))
        return handleFor(file, token, options.gitDir)
    }

    if (now() >= deadline) {
      throw new LockError(
        t('e.lockBusy', { holder: describe(existing), waitMs: options.waitMs ?? 0, file }),
        undefined,
        { gitDir: options.gitDir, holder: existing },
      )
    }
    logger.verbose(t('e.lockWait', { waited: now() - started }))
    await wait(Math.max(10, options.pollMs ?? DEFAULT_POLL_MS))
  }
}

/** Whether an existing lock can be considered abandoned. */
export function isStale(
  record: LockRecord,
  now: number,
  pidAlive: (pid: number) => boolean,
  staleAfterMs: number,
): boolean {
  // No trustworthy creation time means no trustworthy age: leave it alone.
  if (!Number.isFinite(record.createdAt))
    return false
  if (now - record.createdAt >= staleAfterMs)
    return true
  // An unreadable record has no pid to probe; only its age can clear it.
  if (record.pid <= 0)
    return false
  return !pidAlive(record.pid)
}

async function steal(file: string, record: LockRecord): Promise<boolean> {
  try {
    await fs.outputFile(file, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' })
    return true
  }
  catch {
    return false
  }
}

async function handleFor(file: string, token: string, gitDir: string): Promise<LockHandle> {
  let released = false
  return {
    file,
    release: async () => {
      if (released)
        return
      released = true
      const existing = await readFileLock(file)
      // Only delete our own lock: if it was stolen while we ran, deleting it would
      // free the next waiter to start work on top of the new holder.
      if (existing?.token === token)
        await fs.remove(file).catch(() => undefined)
    },
    ensureHeld: async () => {
      const existing = await readFileLock(file)
      if (existing?.token !== token)
        throw new LockError(t('e.lockNotOurs'), undefined, { gitDir, file })
    },
  }
}

function describe(record: LockRecord | null): string {
  if (!record)
    return t('e.lockUnknownHolder')
  return t('e.lockHolder', { pid: record.pid, label: record.label, at: new Date(record.createdAt).toISOString() })
}

/**
 * Run `task` while holding the lock: serialised inside this process and against other
 * processes through the lock file.
 */
export async function withRepoLock<T>(options: RepoLockOptions, task: (handle: LockHandle) => Promise<T>): Promise<T> {
  const file = lockPathFor(options.gitDir)
  return withinProcess(file, async () => {
    const handle = await acquireRepoLock(options)
    try {
      return await task(handle)
    }
    finally {
      await handle.release()
    }
  })
}

/** Exposed for diagnostics: where the lock for a repository root would live. */
export function repoLockPath(gitDir: string): string {
  return lockPathFor(path.resolve(gitDir))
}

/** Read the current holder without acquiring, for `doctor` and error messages. */
export async function readRepoLock(gitDir: string): Promise<LockRecord | null> {
  return readFileLock(lockPathFor(path.resolve(gitDir)))
}
