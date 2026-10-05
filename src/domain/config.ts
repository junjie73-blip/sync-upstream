import type { AuthConfig } from './auth'
import type { ConflictResolutionConfig } from './conflict'
import type { GrayReleaseConfig } from './gray'
import type { RetryConfig } from './retry'
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
  includeFileTypes: string[]
  ignorePatterns: string[]
  retryConfig: RetryConfig
  conflictResolutionConfig: ConflictResolutionConfig
  authConfig?: AuthConfig
  branchStrategyConfig?: BranchStrategyConfig
  grayReleaseConfig?: GrayReleaseConfig
  webhookConfig?: WebhookConfig
  fullRelease: boolean
  rollback: boolean
}

/** Shape accepted from files/CLI/env: every field optional, plus unknown aliases. */
export type RawSyncConfig = Partial<SyncConfig> & Record<string, unknown>
