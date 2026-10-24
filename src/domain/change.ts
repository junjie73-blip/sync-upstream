import type { ConflictCandidate } from './conflict'

/** Every path in the pipeline is a repo-root-relative, slash-separated string. */
export type RepoPath = string

export enum ChangeKind {
  ADD = 'add',
  MODIFY = 'modify',
  DELETE = 'delete',
  /**
   * Upstream moved the file. `path` is where it lives now, `fromPath` where the target branch
   * still has it. Reported apart from add+delete because applying it is `git mv`, which keeps
   * the local file's history and any uncommitted edits on it.
   */
  RENAME = 'rename',
}

export interface ChangeEntry {
  kind: ChangeKind
  path: RepoPath
  /** Directory from `syncDirs` this change belongs to. */
  scope: RepoPath
  upstreamOid?: string
  targetOid?: string
  /** Mode string (`100644`, `100755`, `120000`…) on each side; a mode-only change is still a change. */
  upstreamMode?: string
  targetMode?: string
  /** `link` for symlinks, `blob` for regular files. Absent on deletions of unknown type. */
  objectType?: 'blob' | 'link'
  /** RENAME only: the path upstream no longer has. */
  fromPath?: RepoPath
  /** RENAME only: git's similarity index, 100 = pure move. */
  similarity?: number
}

/**
 * A rename git detected between two revisions: `from` is where the left side still has the
 * file, `to` where the right side has it. `similarity` is git's index, 1-100; 100 means a pure
 * move whose content is byte-identical.
 */
export interface RenamePair {
  from: RepoPath
  to: RepoPath
  similarity: number
}

export interface SkippedEntry {
  path: RepoPath
  reason: SkipReason
  detail?: string
}

export type SkipReason
  = | 'ignored'
    | 'file-type'
    | 'already-synced'
    | 'outside-sync-dirs'
    /** The path is a submodule gitlink; it cannot be synced file-by-file. */
    | 'submodule'
    /** core.symlinks is false here, so writing the link would create a text file instead. */
    | 'symlink-unsupported'
    /** Upstream deleted it and `--no-delete` (or `deletePolicy: 'keep'`) protects it. */
    | 'delete-protected'

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
    rename: count(ChangeKind.RENAME),
    conflict: plan.conflicts.length,
    skipped: plan.skipped.length,
  }
}
