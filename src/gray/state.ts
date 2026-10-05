import type { GrayReleaseStrategy, RepoPath, SyncConfig } from '../domain'
import crypto from 'node:crypto'
import path from 'node:path'
import process from 'node:process'
import fs from 'fs-extra'
import { GrayReleaseStage } from '../domain'
import { FsError, toError } from '../errors'

export const GRAY_STATE_FILE = '.sync-gray.json'

export function newReleaseId(): string {
  return `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`
}

export interface GrayStateData {
  version: 1
  releaseId: string
  stage: GrayReleaseStage
  upstreamRepo: string
  upstreamBranch: string
  companyBranch: string
  strategy: GrayReleaseStrategy
  canaryPaths: RepoPath[]
  pendingPaths: RepoPath[]
  /** Commit created by the canary stage, so a full release or rollback knows what to undo. */
  commitHash?: string
  /** Revision the synced scopes pointed at before this release touched them. */
  baseCommit?: string
  startedAt: string
  endedAt?: string
  errors: string[]
}

function EMPTY(config: SyncConfig, strategy: GrayReleaseStrategy): GrayStateData {
  return {
    version: 1,
    releaseId: newReleaseId(),
    stage: GrayReleaseStage.IDLE,
    upstreamRepo: config.upstreamRepo,
    upstreamBranch: config.upstreamBranch,
    companyBranch: config.companyBranch,
    strategy,
    canaryPaths: [],
    pendingPaths: [],
    startedAt: new Date().toISOString(),
    errors: [],
  }
}

/**
 * Persisted stage record. `--full-release` / `--rollback` act on the paths stored here,
 * which is what makes them independent of a second plan run producing the same tree.
 */
export class GrayState {
  private constructor(
    private readonly filePath: string,
    private data: GrayStateData,
  ) {}

  static pathFor(cwd = process.cwd()): string {
    return path.join(cwd, GRAY_STATE_FILE)
  }

  static async open(filePath: string, config: SyncConfig, strategy: GrayReleaseStrategy): Promise<GrayState> {
    let data: GrayStateData | null = null
    if (await fs.pathExists(filePath)) {
      try {
        data = await fs.readJson(filePath) as GrayStateData
      }
      catch (error) {
        throw new FsError(`灰度状态文件无法读取: ${filePath}`, toError(error))
      }
    }
    // A state file from another repo/branch/strategy cannot describe this release.
    if (data
      && data.version === 1
      && data.upstreamRepo === config.upstreamRepo
      && data.upstreamBranch === config.upstreamBranch
      && data.companyBranch === config.companyBranch
      && data.strategy === strategy) {
      return new GrayState(filePath, { ...data, errors: data.errors ?? [] })
    }
    return new GrayState(filePath, EMPTY(config, strategy))
  }

  get releaseId(): string {
    return this.data.releaseId
  }

  get stage(): GrayReleaseStage {
    return this.data.stage
  }

  get commitHash(): string | undefined {
    return this.data.commitHash
  }

  get baseCommit(): string | undefined {
    return this.data.baseCommit
  }

  get canaryPaths(): RepoPath[] {
    return this.data.canaryPaths
  }

  get pendingPaths(): RepoPath[] {
    return this.data.pendingPaths
  }

  get isActive(): boolean {
    return this.data.stage !== GrayReleaseStage.IDLE && this.data.canaryPaths.length > 0
  }

  get errors(): string[] {
    return this.data.errors
  }

  begin(paths: { canary: RepoPath[], pending: RepoPath[], baseCommit: string }): void {
    this.data = {
      ...this.data,
      stage: GrayReleaseStage.CANARY,
      canaryPaths: paths.canary,
      pendingPaths: paths.pending,
      baseCommit: paths.baseCommit,
      commitHash: undefined,
      startedAt: new Date().toISOString(),
      endedAt: undefined,
      errors: [],
    }
  }

  advance(stage: GrayReleaseStage, patch: Partial<Pick<GrayStateData, 'commitHash' | 'endedAt'>> = {}): void {
    this.data = { ...this.data, ...patch, stage }
    if (stage === GrayReleaseStage.COMPLETED || stage === GrayReleaseStage.FAILED || stage === GrayReleaseStage.ROLLED_BACK) {
      this.data.endedAt = new Date().toISOString()
    }
  }

  consumePending(paths: RepoPath[]): void {
    const remaining = new Set(paths)
    this.data.pendingPaths = this.data.pendingPaths.filter(repoPath => remaining.has(repoPath))
  }

  fail(message: string): void {
    this.data.errors.push(message)
    this.data.stage = GrayReleaseStage.FAILED
    this.data.endedAt = new Date().toISOString()
  }

  async save(): Promise<void> {
    try {
      await fs.writeJson(this.filePath, this.data, { spaces: 2 })
    }
    catch (error) {
      throw new FsError(`灰度状态文件无法写入: ${this.filePath}`, toError(error))
    }
  }

  async clear(): Promise<void> {
    this.data = {
      ...this.data,
      stage: GrayReleaseStage.IDLE,
      canaryPaths: [],
      pendingPaths: [],
      commitHash: undefined,
      baseCommit: undefined,
      errors: [],
    }
    await fs.remove(this.filePath).catch(() => undefined)
  }

  toJSON(): GrayStateData {
    return this.data
  }
}
