import type { AppliedChange, RepoPath } from '../domain'
import fs from 'fs-extra'
import { ChangeKind } from '../domain'
import { FsError, toError } from '../errors'

export interface SyncStateEntry {
  upstreamOid: string
  syncedAt: string
}

export interface SyncStateData {
  version: 1
  upstreamRepo: string
  upstreamBranch: string
  entries: Record<RepoPath, SyncStateEntry>
}

const EMPTY: SyncStateData = { version: 1, upstreamRepo: '', upstreamBranch: '', entries: {} }

/**
 * Records which upstream blob each synced path currently holds, so `forceOverwrite: false`
 * can skip work already done. Blob oids are content hashes, which makes this both cheaper
 * and more accurate than the md5-of-working-files map the old implementation kept.
 */
export class SyncState {
  private constructor(
    private readonly filePath: string,
    private data: SyncStateData,
  ) {}

  static empty(filePath: string, upstreamRepo = '', upstreamBranch = ''): SyncState {
    return new SyncState(filePath, { version: 1, upstreamRepo, upstreamBranch, entries: {} })
  }

  static async load(filePath: string, upstreamRepo: string, upstreamBranch: string): Promise<SyncState> {
    let data: SyncStateData
    try {
      data = await fs.pathExists(filePath)
        ? await fs.readJson(filePath) as SyncStateData
        : SyncState.blank(upstreamRepo, upstreamBranch)
    }
    catch (error) {
      throw new FsError(`同步状态文件无法读取: ${filePath}`, toError(error))
    }

    const usable = data?.version === 1
      && data.upstreamRepo === upstreamRepo
      && data.upstreamBranch === upstreamBranch
    if (!usable) {
      // A fresh or discarded state must still carry the repo/branch it belongs to,
      // otherwise the first `save()` writes an identity that can never be reloaded.
      return new SyncState(filePath, SyncState.blank(upstreamRepo, upstreamBranch))
    }
    return new SyncState(filePath, { ...data, entries: data.entries ?? {} })
  }

  private static blank(upstreamRepo: string, upstreamBranch: string): SyncStateData {
    return { ...EMPTY, upstreamRepo, upstreamBranch, entries: {} }
  }

  get size(): number {
    return Object.keys(this.data.entries).length
  }

  isSynced(repoPath: RepoPath, upstreamOid: string): boolean {
    return this.data.entries[repoPath]?.upstreamOid === upstreamOid
  }

  record(applied: AppliedChange[]): void {
    const syncedAt = new Date().toISOString()
    for (const change of applied) {
      if (change.status === 'failed')
        continue
      const { entry } = change
      if (entry.kind === ChangeKind.DELETE || !entry.upstreamOid) {
        delete this.data.entries[entry.path]
        continue
      }
      if (change.status === 'kept-target')
        continue
      this.data.entries[entry.path] = { upstreamOid: entry.upstreamOid, syncedAt }
    }
  }

  forget(repoPaths: RepoPath[]): void {
    for (const repoPath of repoPaths) delete this.data.entries[repoPath]
  }

  async save(): Promise<void> {
    try {
      await fs.writeJson(this.filePath, this.data, { spaces: 2 })
    }
    catch (error) {
      throw new FsError(`同步状态文件无法写入: ${this.filePath}`, toError(error))
    }
  }
}

export const SYNC_STATE_FILE = '.sync-state.json'
