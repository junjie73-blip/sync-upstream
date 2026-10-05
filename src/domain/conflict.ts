import type { RepoPath } from './change'

export enum ConflictType {
  CONTENT = 'content',
  TYPE = 'type',
  DELETE_MODIFY = 'delete-modify',
  ADD_ADD = 'add-add',
  SYMLINK = 'symlink',
  UNTRACKED_OVERWRITE = 'untracked-overwrite',
  UNREADABLE = 'unreadable',
}

export enum ConflictResolutionStrategy {
  USE_SOURCE = 'use-source',
  KEEP_TARGET = 'keep-target',
  AUTO_MERGE = 'auto-merge',
  PROMPT_USER = 'prompt-user',
  SKIP = 'skip',
}

export interface ConflictResolutionConfig {
  defaultStrategy: ConflictResolutionStrategy
  /** Extensions resolved with `defaultStrategy` without prompting. */
  autoResolveTypes?: string[]
  logResolutions?: boolean
  resolutionLogFile?: string
}

/** A path that both sides touched since the merge base. */
export interface ConflictCandidate {
  path: RepoPath
  conflictType: ConflictType
  /** Blob oid on each side; undefined means the file is absent on that side. */
  baseOid?: string
  localOid?: string
  upstreamOid?: string
  /** Only set for TYPE conflicts, where the path is a directory on one side. */
  targetOid?: string
}

export type ConflictAction = 'take-upstream' | 'keep-local' | 'skip' | 'write-merged'

export interface ConflictDecision {
  path: RepoPath
  conflictType: ConflictType
  strategy: ConflictResolutionStrategy
  action: ConflictAction
  /** Present when action is `write-merged`. */
  mergedContent?: string
  detail?: string
}

/** Content access injected so the resolver stays independent from git and the file system. */
export interface ConflictContentSource {
  base: (path: RepoPath) => Promise<string | null>
  local: (path: RepoPath) => Promise<string | null>
  upstream: (path: RepoPath) => Promise<string | null>
}

export type ConflictPrompt = (candidate: ConflictCandidate) => Promise<ConflictResolutionStrategy | null>

export interface ConflictRecord {
  path: RepoPath
  type: ConflictType
  strategy: ConflictResolutionStrategy
  action: ConflictAction
  detail?: string
}
