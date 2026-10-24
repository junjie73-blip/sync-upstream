import type { NotifyConfig, SyncConfig } from '../domain'
import { BranchStrategy, ConflictResolutionStrategy, DEFAULT_FETCH_CONFIG, DEFAULT_RENAME_THRESHOLD } from '../domain'

/**
 * `channels` starts empty on purpose: enabling notifications without naming a channel is a
 * mistake worth reporting, not a hint about what the user probably meant.
 */
export const DEFAULT_NOTIFY_CONFIG: NotifyConfig = {
  enable: false,
  channels: [],
  events: ['success', 'conflict', 'failure', 'undo'],
  timeoutMs: 5000,
  retries: 2,
  includeDetails: true,
}

export const DEFAULT_CONFIG: SyncConfig = {
  upstreamRepo: '',
  upstreamBranch: 'main',
  companyBranch: 'main',
  syncDirs: [],
  commitMessage: 'Sync upstream changes to specified directories',
  autoPush: false,
  forceOverwrite: true,
  verbose: false,
  silent: false,
  dryRun: false,
  previewOnly: false,
  nonInteractive: false,
  concurrencyLimit: 10,
  lockWaitMs: 0,
  includeFileTypes: [],
  ignorePatterns: [],
  deletePolicy: 'mirror',
  renameDetection: true,
  renameThreshold: DEFAULT_RENAME_THRESHOLD,
  retryConfig: {
    maxRetries: 3,
    initialDelay: 2000,
    backoffFactor: 1.5,
  },
  conflictResolutionConfig: {
    defaultStrategy: ConflictResolutionStrategy.PROMPT_USER,
    autoResolveTypes: [],
    logResolutions: true,
  },
  fetchConfig: DEFAULT_FETCH_CONFIG,
  branchStrategyConfig: {
    enable: false,
    strategy: BranchStrategy.FEATURE,
    baseBranch: 'main',
    branchPattern: 'feature/sync-{date}',
    autoSwitchBack: true,
    autoDeleteMergedBranches: false,
  },
  fullRelease: false,
  rollback: false,
  notifyConfig: DEFAULT_NOTIFY_CONFIG,
}

export const CONFIG_FILE_NAMES = [
  'sync-upstream.config.json',
  'sync-upstream.config.json5',
  'sync-upstream.config.yaml',
  'sync-upstream.config.yml',
  'sync-upstream.config.toml',
  'sync-upstream.json',
  'sync-upstream.json5',
  'sync-upstream.yaml',
  'sync-upstream.yml',
  'sync-upstream.toml',
  '.sync-toolrc.json5',
  '.sync-toolrc.json',
  '.sync-toolrc.yaml',
  '.sync-toolrc.yml',
  '.sync-toolrc.toml',
  '.sync-toolrc',
]
