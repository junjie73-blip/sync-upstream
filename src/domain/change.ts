import type { ConflictCandidate } from './conflict'

/** Every path in the pipeline is a repo-root-relative, slash-separated string. */
export type RepoPath = string

export enum ChangeKind {
  ADD = 'add',
  MODIFY = 'modify',
  DELETE = 'delete',
}

export interface ChangeEntry {
  kind: ChangeKind
  path: RepoPath
  /** Directory from `syncDirs` this change belongs to. */
  scope: RepoPath
  upstreamOid?: string
  targetOid?: string
}

export interface SkippedEntry {
  path: RepoPath
  reason: 'ignored' | 'file-type' | 'already-synced' | 'outside-sync-dirs'
}

export interface SyncPlan {
  upstreamRef: string
  targetBranch: string
  changes: ChangeEntry[]
  /** Paths both sides touched since the merge base; resolved just before applying. */
  conflicts: ConflictCandidate[]
  skipped: SkippedEntry[]
  /** Working tree was dirty inside a sync scope before applying. */
  dirty: RepoPath[]
}

export interface AppliedChange {
  entry: ChangeEntry
  status: 'applied' | 'kept-target' | 'failed'
  error?: string
}

export interface ApplyResult {
  applied: AppliedChange[]
  stagedPaths: RepoPath[]
}

export interface CommitResult {
  created: boolean
  hash?: string
  stagedCount: number
  reason?: string
}

export function planSummary(plan: SyncPlan) {
  const count = (kind: ChangeKind) => plan.changes.filter(c => c.kind === kind).length
  return {
    add: count(ChangeKind.ADD),
    modify: count(ChangeKind.MODIFY),
    delete: count(ChangeKind.DELETE),
    conflict: plan.conflicts.length,
    skipped: plan.skipped.length,
  }
}
