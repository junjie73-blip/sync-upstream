import type { Buffer } from 'node:buffer'
import type { RepoPath } from '../domain'
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'fs-extra'
import { joinRepoPath } from '../fsx/paths'

/**
 * The first line of every Git LFS pointer, exactly as written by `git lfs` since 2015.
 * Checking the line is cheaper and far more reliable than parsing `.gitattributes`: it is the
 * thing itself, and it is what lands in the working tree when a fetch was done with smudge off.
 */
const POINTER_FIRST_LINE = 'version https://git-lfs.github.com/spec/v1'

/** Longest conceivable pointer: version, oid with a sha256, and a size. */
const POINTER_MAX_BYTES = 256

export function isLfsPointer(content: string): boolean {
  if (content.length > POINTER_MAX_BYTES || !content.startsWith(POINTER_FIRST_LINE))
    return false
  // A real pointer says which object it stands for; anything else is a file that only looks like one.
  return /\noid\s+sha256:[0-9a-f]{64}\nsize\s+\d+\n?$/.test(content)
}

/** Reads one path's bytes, or null when it cannot be read. */
export type ContentReader = (repoPath: RepoPath) => Promise<string | null>

export interface PointerScan {
  /** Paths whose content is an LFS pointer. */
  pointers: RepoPath[]
  /** Paths that could not be read (deleted, permission, racing edit). */
  unreadable: RepoPath[]
}

/**
 * Which of these paths hold LFS pointers, using whatever reader the caller has.
 *
 * Two readers exist on purpose: after applying, the working tree is the truth; in preview the
 * working tree has not been touched, so the question has to be asked of the upstream ref instead.
 * Both answers are "what content would land here", which is the only thing that matters for the
 * warning — parsing `.gitattributes` would only guess at it.
 */
export async function detectLfsPointers(paths: RepoPath[], read: ContentReader): Promise<PointerScan> {
  const pointers: RepoPath[] = []
  const unreadable: RepoPath[] = []

  for (const repoPath of paths) {
    let content: string | null
    try {
      content = await read(repoPath)
    }
    catch {
      content = null
    }
    if (content === null) {
      unreadable.push(repoPath)
      continue
    }
    if (content.length <= POINTER_MAX_BYTES && isLfsPointer(content))
      pointers.push(repoPath)
  }

  return { pointers, unreadable }
}

/** Pointers as they now sit in the working tree. */
export function scanWorkingTreePointers(repoRoot: string, paths: RepoPath[]): Promise<PointerScan> {
  return detectLfsPointers(paths, async (repoPath) => {
    const target = joinRepoPath(repoRoot, repoPath)
    const stat = await fs.stat(target)
    // Only a small text file can be a pointer; do not even open a 2 GB video.
    if (stat.size > POINTER_MAX_BYTES)
      return ''
    return fs.readFile(target, 'utf8')
  })
}

export interface LfsCommandResult {
  ok: boolean
  /** First meaningful line of stderr, for the note the operator sees. */
  error?: string
}

/**
 * Run `git lfs …`.
 *
 * Spawned rather than fed through simple-git because `git lfs` is a *git subcommand shim*: it is
 * only on PATH when git-lfs is installed, and the "is it installed" answer is the whole point of
 * calling this — a wrapper that reports a git error would hide it.
 */
async function runLfs(cwd: string, args: string[], timeoutMs: number): Promise<LfsCommandResult> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, windowsHide: true })
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      settled = true
      child.kill()
      resolve({ ok: false, error: `git lfs ${args[0] ?? ''} 超时（${Math.round(timeoutMs / 1000)}s）` })
    }, timeoutMs)

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      if (settled)
        return
      settled = true
      clearTimeout(timer)
      // `ENOENT` here has exactly one meaning worth reporting: git-lfs is not installed, and
      // "materialize" can never work on this machine. Anything else is passed through verbatim.
      const code = (error as NodeJS.ErrnoException).code
      resolve({ ok: false, error: code === 'ENOENT' ? '本机没有安装 git-lfs' : error.message })
    })
    child.on('close', (code) => {
      if (settled)
        return
      settled = true
      clearTimeout(timer)
      resolve(code === 0 ? { ok: true } : { ok: false, error: firstLine(stderr) || `git lfs ${args[0] ?? ''} 退出码 ${code}` })
    })
  })
}

function firstLine(value: string): string {
  return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean).pop() ?? ''
}

export function lfsIncludePatterns(paths: RepoPath[]): string {
  return paths.join(',')
}

export interface MaterializeRequest {
  cwd: string
  /** Remote that owns the LFS server for these objects — the upstream, not `origin`. */
  remote: string
  /** Ref to fetch the objects for, as git would accept it (`refs/remotes/sync-upstream/main`). */
  ref: string
  paths: RepoPath[]
  timeoutMs?: number
}

export interface MaterializeOutcome {
  attempted: boolean
  replaced: RepoPath[]
  /** Why nothing (or not everything) came back: missing git-lfs, refused by the server, timeout. */
  note?: string
}

/**
 * Replace pointer files with the real objects, the way `git lfs` intends.
 *
 * Two steps because that is how LFS works: the objects must be in the local cache before the
 * working tree can be filled from them. Neither step may fail a sync — the pointers are already
 * committed-ready content, and a note that says "3 个文件仍是 LFS 指针" is a useful outcome, while
 * a rolled-back sync of a thousand source files is not.
 *
 * The exit code is not the answer. `git lfs checkout` leaves a pointer untouched and still exits 0
 * when the object never arrived, which is exactly what happens against a remote with no LFS
 * server, so the files themselves are asked which ones actually became real content.
 */
export async function materializeLfsPointers(request: MaterializeRequest): Promise<MaterializeOutcome> {
  if (request.paths.length === 0)
    return { attempted: false, replaced: [] }

  const timeoutMs = request.timeoutMs ?? 120_000
  const include = lfsIncludePatterns(request.paths)

  const fetched = await runLfs(request.cwd, ['lfs', 'fetch', '--include', include, request.remote, request.ref], timeoutMs)
  if (!fetched.ok)
    return { attempted: true, replaced: [], note: fetched.error }

  const checkedOut = await runLfs(request.cwd, ['lfs', 'checkout', '--', ...request.paths], timeoutMs)
  if (!checkedOut.ok)
    return { attempted: true, replaced: [], note: checkedOut.error }

  // A path that is still a pointer — or vanished, which is not "materialized" either.
  const scan = await scanWorkingTreePointers(request.cwd, request.paths)
  const unchanged = new Set<RepoPath>([...scan.pointers, ...scan.unreadable])
  const replaced = request.paths.filter(item => !unchanged.has(item))
  const outcome: MaterializeOutcome = { attempted: true, replaced }

  if (replaced.length === 0)
    outcome.note = 'git lfs 命令没有报错，但一个对象都没取回：这个远程没有启用 LFS 服务，或上游的 LFS 对象不可达'
  else if (replaced.length < request.paths.length)
    outcome.note = `${request.paths.length - replaced.length} 个文件对应的对象不在上游 LFS 服务里，仍是指针`

  return outcome
}

/**
 * Is git-lfs usable here?
 *
 * `doctor` asks so that "materialize" in the config can be reported as the dead option it is on a
 * machine without the CLI, instead of silently degrading on every run.
 */
export async function lfsAvailable(cwd: string): Promise<boolean> {
  return (await runLfs(cwd, ['lfs', 'version'], 15_000)).ok
}

/** Where the LFS cache lives, for a hint that does not require the reader to know the tool. */
export function lfsCacheHint(cwd: string): string {
  return path.join(cwd, '.git', 'lfs')
}
