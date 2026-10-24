import type { AppliedChange, RepoPath } from '../domain'
import path from 'node:path'
import process from 'node:process'
import fs from 'fs-extra'
import { ChangeKind } from '../domain'
import { FsError, toError } from '../errors'
import { t } from '../i18n'

export interface SyncStateEntry {
  upstreamOid: string
  /** File mode as it was applied. Absent for records migrated from the v1 format. */
  mode?: string
  syncedAt: string
}

/** One finished sync, kept so `--undo` and `sync-upstream history` can talk about the past. */
export interface SyncHistoryRecord {
  commit: string
  /** The upstream object this commit was taken from (branch, tag or revision). */
  source: string
  upstreamOid?: string
  syncedAt: string
  files: number
  /** Paths this commit touched, so an undo can be scoped without diffing afterwards. */
  paths: RepoPath[]
  /** Commit that was HEAD before this sync; what an undo restores from. */
  baseCommit: string
  branch: string
}

export interface SyncStateIdentity {
  upstreamRepo: string
  upstreamBranch: string
  companyBranch: string
}

export interface SyncStateData {
  version: 2
  upstreamRepo: string
  upstreamBranch: string
  companyBranch: string
  /** Most recent sync commit created by this tool. */
  lastSyncCommit?: string
  history: SyncHistoryRecord[]
  entries: Record<RepoPath, SyncStateEntry>
}

/** Shape written by older releases: no mode, no target branch, no history. */
interface SyncStateDataV1 {
  version: 1
  upstreamRepo: string
  upstreamBranch: string
  entries?: Record<RepoPath, { upstreamOid: string, syncedAt: string }>
}

export type SyncStateFile = SyncStateData | SyncStateDataV1

/**
 * A blank state has to own its `entries`/`history` containers — sharing them with a module
 * constant would make every instance in the process write into the same records.
 */
function blankData(identity: Partial<SyncStateIdentity> = {}): SyncStateData {
  return {
    version: 2,
    upstreamRepo: identity.upstreamRepo ?? '',
    upstreamBranch: identity.upstreamBranch ?? '',
    companyBranch: identity.companyBranch ?? '',
    history: [],
    entries: {},
  }
}

/** How many past syncs to keep; enough for `history` output and a bounded file. */
export const HISTORY_LIMIT = 50

/**
 * Records which upstream blob (and mode) each synced path currently holds, so
 * `forceOverwrite: false` can skip work already done. Blob oids are content hashes, which
 * makes this both cheaper and more accurate than the md5-of-working-files map the old
 * implementation kept. The mode has to travel with the oid: without it a pure
 * `100644 → 100755` change looks identical to what was already synced, and the exec bit
 * silently never arrives downstream.
 */
export class SyncState {
  private constructor(
    private readonly filePath: string,
    private data: SyncStateData,
  ) {}

  static empty(filePath: string, identity: Partial<SyncStateIdentity> = {}): SyncState {
    return new SyncState(filePath, blankData(identity))
  }

  static async load(filePath: string, identity: SyncStateIdentity): Promise<SyncState> {
    let data: SyncStateFile | undefined
    try {
      data = await fs.pathExists(filePath)
        ? await fs.readJson(filePath) as SyncStateFile
        : undefined
    }
    catch (error) {
      throw new FsError(t('e.stateRead', { file: filePath }), toError(error))
    }

    if (!data || !matchesIdentity(data, identity)) {
      // A fresh or discarded state must still carry the identity it belongs to,
      // otherwise the first `save()` writes an identity that can never be reloaded.
      return new SyncState(filePath, blankData(identity))
    }
    return new SyncState(filePath, migrate(data, identity))
  }

  get size(): number {
    return Object.keys(this.data.entries).length
  }

  get lastSyncCommit(): string | undefined {
    return this.data.lastSyncCommit
  }

  get history(): SyncHistoryRecord[] {
    return this.data.history
  }

  get snapshot(): SyncStateData {
    return this.data
  }

  /**
   * A v1 record carries no mode, so its entries fall back to oid-only matching instead of
   * forcing a full re-sync of every file the first time the new format runs.
   */
  isSynced(repoPath: RepoPath, upstreamOid: string, mode?: string): boolean {
    const entry = this.data.entries[repoPath]
    if (!entry || entry.upstreamOid !== upstreamOid)
      return false
    if (entry.mode === undefined || mode === undefined)
      return true
    return entry.mode === mode
  }

  record(applied: AppliedChange[]): void {
    const syncedAt = new Date().toISOString()
    for (const change of applied) {
      // Failed and kept-local changes did not touch the repository, so their state must not move.
      if (change.status === 'failed' || change.status === 'kept-target')
        continue
      const { entry } = change
      // The path upstream renamed away from holds nothing synced any more — not even after a
      // pure move, because the content now lives under its new name.
      if (entry.fromPath)
        delete this.data.entries[entry.fromPath]
      if (entry.kind === ChangeKind.DELETE || !entry.upstreamOid) {
        delete this.data.entries[entry.path]
        continue
      }
      this.data.entries[entry.path] = {
        upstreamOid: entry.upstreamOid,
        mode: entry.upstreamMode,
        syncedAt,
      }
    }
  }

  forget(repoPaths: RepoPath[]): void {
    for (const repoPath of repoPaths) delete this.data.entries[repoPath]
  }

  /** Append one finished sync; the newest record is the one `--undo` steps back over. */
  recordSyncCommit(record: Omit<SyncHistoryRecord, 'syncedAt'>): void {
    this.data.lastSyncCommit = record.commit
    this.data.history = [
      { ...record, syncedAt: new Date().toISOString() },
      ...this.data.history,
    ].slice(0, HISTORY_LIMIT)
  }

  /** Drop the newest history record once it has been undone. */
  popSyncCommit(): SyncHistoryRecord | undefined {
    const [latest, ...rest] = this.data.history
    this.data.history = rest
    this.data.lastSyncCommit = rest[0]?.commit
    return latest
  }

  /**
   * Write via a temp file plus rename. `fs.writeJson` truncates in place, so a second
   * process (or a crash halfway) could read a zero-length or half-written state file and
   * silently forget which files were already synced.
   */
  async save(): Promise<void> {
    const temporary = `${this.filePath}.${process.pid}.tmp`
    try {
      await fs.outputFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8')
      await fs.move(temporary, this.filePath, { overwrite: true })
    }
    catch (error) {
      await fs.remove(temporary).catch(() => undefined)
      throw new FsError(t('e.stateWrite', { file: this.filePath }), toError(error))
    }
  }
}

function matchesIdentity(data: SyncStateFile, identity: SyncStateIdentity): boolean {
  if (data.version === 1) {
    return data.upstreamRepo === identity.upstreamRepo && data.upstreamBranch === identity.upstreamBranch
  }
  return data.version === 2
    && data.upstreamRepo === identity.upstreamRepo
    && data.upstreamBranch === identity.upstreamBranch
    // Two company branches sharing one checkout must not mark each other's work
    // "already synced" — the state is per (upstream, target) pair.
    && data.companyBranch === identity.companyBranch
}

function migrate(data: SyncStateFile, identity: SyncStateIdentity): SyncStateData {
  if (data.version === 2) {
    return { ...data, history: data.history ?? [], entries: data.entries ?? {} }
  }
  const entries: Record<RepoPath, SyncStateEntry> = {}
  for (const [repoPath, entry] of Object.entries(data.entries ?? {})) {
    entries[repoPath] = { upstreamOid: entry.upstreamOid, syncedAt: entry.syncedAt }
  }
  return {
    version: 2,
    upstreamRepo: identity.upstreamRepo,
    upstreamBranch: identity.upstreamBranch,
    companyBranch: identity.companyBranch,
    history: [],
    entries,
  }
}

export const SYNC_STATE_FILE = '.sync-state.json'

/** Directory the state file lives in, resolved relative to the repository root. */
export function syncStatePath(repoRoot: string, file: string = SYNC_STATE_FILE): string {
  return path.join(repoRoot, file)
}
