import type { SyncConfig } from '../domain'
import { BranchStrategy, ConflictResolutionStrategy } from '../domain'

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
  includeFileTypes: [],
  ignorePatterns: [],
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
