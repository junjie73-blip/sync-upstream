import type {
  ChangeEntry,
  ConflictCandidate,
  RepoPath,
  SkippedEntry,
  SyncConfig,
  SyncPlan,
} from '../domain'
import type { IgnoreMatcher } from '../fsx/ignore-rules'
import type { GitRepository, TreeEntry } from '../git/repository'
import type { SyncState } from './sync-state'
import { ChangeKind, ConflictType } from '../domain'
import { extensionOf } from '../fsx/paths'
import { diffTrees } from './change-set'

export interface PlanContext {
  git: GitRepository
  config: SyncConfig
  upstreamRef: string
  ignore: IgnoreMatcher
  state?: SyncState
}

function keepChange(change: ChangeEntry, config: SyncConfig, ignore: IgnoreMatcher, skipped: SkippedEntry[]): boolean {
  if (ignore.isIgnored(change.path, false)) {
    skipped.push({ path: change.path, reason: 'ignored' })
    return false
  }
  if (config.includeFileTypes.length > 0 && !config.includeFileTypes.includes(extensionOf(change.path))) {
    skipped.push({ path: change.path, reason: 'file-type' })
    return false
  }
  return true
}

/**
 * Build the change list from the object database: upstream revision vs the target branch,
 * minus ignored paths, minus already-synced blobs, plus the paths that need conflict handling.
 */
export async function buildPlan(context: PlanContext): Promise<SyncPlan> {
  const { git, config, upstreamRef, ignore, state } = context
  const scopes = config.syncDirs
  const skipped: SkippedEntry[] = []

  const [upstreamTree, targetTree] = await Promise.all([
    git.listTree(upstreamRef, scopes),
    git.listTree(config.companyBranch, scopes),
  ])

  const kept: ChangeEntry[] = []
  for (const change of diffTrees(targetTree, upstreamTree, scopes)) {
    if (!keepChange(change, config, ignore, skipped))
      continue
    if (!config.forceOverwrite && state && change.upstreamOid && state.isSynced(change.path, change.upstreamOid)) {
      skipped.push({ path: change.path, reason: 'already-synced' })
      continue
    }
    kept.push(change)
  }

  const [modified, untracked] = await Promise.all([
    git.locallyModifiedPaths(scopes),
    git.untrackedPaths(scopes),
  ])
  const modifiedSet = new Set<RepoPath>(modified)
  const untrackedSet = new Set<RepoPath>(untracked)

  const conflicts: ConflictCandidate[] = []
  for (const change of kept) {
    if (change.kind === ChangeKind.MODIFY && modifiedSet.has(change.path)) {
      conflicts.push({
        path: change.path,
        conflictType: ConflictType.CONTENT,
        localOid: change.targetOid,
        upstreamOid: change.upstreamOid,
      })
    }
    else if (change.kind === ChangeKind.DELETE && modifiedSet.has(change.path)) {
      conflicts.push({
        path: change.path,
        conflictType: ConflictType.DELETE_MODIFY,
        localOid: change.targetOid,
      })
    }
    else if (change.kind === ChangeKind.ADD && untrackedSet.has(change.path)) {
      conflicts.push({
        path: change.path,
        conflictType: ConflictType.UNTRACKED_OVERWRITE,
        upstreamOid: change.upstreamOid,
      })
    }
  }

  const conflictPaths = new Set(conflicts.map(conflict => conflict.path))
  conflicts.push(...typeConflicts(kept, targetTree, upstreamTree, conflictPaths))

  if (conflicts.length > 0) {
    await attachBaseOids(git, config, upstreamRef, conflicts)
  }

  return {
    upstreamRef,
    targetBranch: config.companyBranch,
    changes: kept,
    conflicts,
    skipped,
    dirty: modified,
  }
}

/**
 * A path that is a file on one side and a directory on the other cannot be checked out
 * directly; flag it so the apply stage removes the local tree first.
 */
function typeConflicts(
  changes: ChangeEntry[],
  targetTree: Map<RepoPath, TreeEntry>,
  upstreamTree: Map<RepoPath, TreeEntry>,
  existing: Set<RepoPath>,
): ConflictCandidate[] {
  const found: ConflictCandidate[] = []
  const hasChildren = (tree: Map<RepoPath, TreeEntry>, prefix: RepoPath) => {
    const dir = `${prefix}/`
    for (const key of tree.keys()) {
      if (key.startsWith(dir))
        return true
    }
    return false
  }

  for (const change of changes) {
    if (existing.has(change.path))
      continue
    if ((change.kind === ChangeKind.ADD || change.kind === ChangeKind.MODIFY) && hasChildren(targetTree, change.path)) {
      found.push({ path: change.path, conflictType: ConflictType.TYPE, upstreamOid: change.upstreamOid, targetOid: change.targetOid })
    }
    else if (change.kind === ChangeKind.DELETE && hasChildren(upstreamTree, change.path)) {
      found.push({ path: change.path, conflictType: ConflictType.TYPE, targetOid: change.targetOid })
    }
  }
  return found
}

/** The merge base gives the 3-way merge its "unchanged side" reference. */
async function attachBaseOids(
  git: GitRepository,
  config: SyncConfig,
  upstreamRef: string,
  conflicts: ConflictCandidate[],
): Promise<void> {
  const base = await git.mergeBase(config.companyBranch, upstreamRef)
  if (!base)
    return

  const paths = new Set(conflicts.map(conflict => conflict.path))
  const baseTree = await git.listTree(base, [...paths])
  for (const conflict of conflicts) {
    conflict.baseOid = baseTree.get(conflict.path)?.oid
  }
}

export function changesByKind(plan: SyncPlan, kind: ChangeKind): ChangeEntry[] {
  return plan.changes.filter(change => change.kind === kind)
}
