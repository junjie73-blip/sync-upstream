import type { AuthConfig } from './auth'
import type { ConflictResolutionConfig } from './conflict'
import type { FetchConfig } from './fetch'
import type { GrayReleaseConfig } from './gray'
import type { LogConfig } from './log'
import type { NotifyConfig } from './notify'
import type { DeletePolicy, PrConfig } from './policy'
import type { RetryConfig } from './retry'
import type { UpstreamSource } from './upstream'
import type { WebhookConfig } from './webhook'

export enum BranchStrategy {
  FEATURE = 'feature',
  RELEASE = 'release',
  HOTFIX = 'hotfix',
  DEVELOP = 'develop',
}

export interface BranchStrategyConfig {
  enable: boolean
  strategy: BranchStrategy
  baseBranch: string
  branchPattern: string
  autoSwitchBack: boolean
  autoDeleteMergedBranches: boolean
}

export interface SyncConfig {
  upstreamRepo: string
  upstreamBranch: string
  /** Branch of the downstream (company) repository being updated. */
  companyBranch: string
  syncDirs: string[]
  /**
   * Additional upstreams to fan into the same target branch (多上游 fan-in). When present, this
   * run works through the list instead of the top-level `upstreamRepo`/`upstreamBranch`, and each
   * source gets its own remote, state file, and commit.
   */
  upstreams?: UpstreamSource[]
  commitMessage: string
  autoPush: boolean
  /** Apply every planned change instead of only files changed since last sync. */
  forceOverwrite: boolean
  verbose: boolean
  silent: boolean
  dryRun: boolean
  previewOnly: boolean
  nonInteractive: boolean
  concurrencyLimit: number
  /**
   * Milliseconds to wait for another sync's repository lock. 0 (default) reports the
   * clash immediately instead of queueing a CI job behind an unknown process.
   */
  lockWaitMs: number
  includeFileTypes: string[]
  ignorePatterns: string[]
  /**
   * What to do with files the target branch has and the upstream dropped. `mirror` (default)
   * deletes them, exactly like every previous release; `keep` leaves them alone and reports the
   * skip; `ask` asks once per run when a terminal can answer.
   */
  deletePolicy: DeletePolicy
  /**
   * Fold upstream renames into one change instead of a delete plus an add, so a moved file keeps
   * its local edits and its history. Default true; `deletePolicy: 'keep'` disables it because a
   * rename does remove the old path.
   */
  renameDetection: boolean
  /** Similarity (1-100) below which a delete/add pair is not treated as one file. */
  renameThreshold: number
  retryConfig: RetryConfig
  conflictResolutionConfig: ConflictResolutionConfig
  /**
   * How much of the upstream is pulled locally (object filtering, depth, tags) and what to do
   * with Git LFS files. Defaults keep the historical behaviour: fetch everything, no LFS calls.
   */
  fetchConfig: FetchConfig
  /**
   * Copy the log to a file that rotates. Absent means console only, which is what a one-shot CLI
   * run wants and what every release up to 0.2 did.
   */
  logConfig?: LogConfig
  authConfig?: AuthConfig
  branchStrategyConfig?: BranchStrategyConfig
  grayReleaseConfig?: GrayReleaseConfig
  webhookConfig?: WebhookConfig
  /** Post-run announcements (stdout / HTTP / Slack / 钉钉 / 企业微信). */
  notifyConfig?: NotifyConfig
  /**
   * GitOps mode: sync onto a generated branch, push it, and hand the reviewer a pull request
   * instead of rewriting the target branch. See `PrConfig`.
   */
  prConfig?: PrConfig
  fullRelease: boolean
  rollback: boolean
}

/** Shape accepted from files/CLI/env: every field optional, plus unknown aliases. */
export type RawSyncConfig = Partial<SyncConfig> & Record<string, unknown>
