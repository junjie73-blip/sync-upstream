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
import { diffTrees, gitlinkPaths } from './change-set'
import { foldRenames, renameNeedsContent } from './renames'

export interface PlanContext {
  git: GitRepository
  config: SyncConfig
  upstreamRef: string
  ignore: IgnoreMatcher
  state?: SyncState
  /**
   * False when this checkout has `core.symlinks=false` (the Windows default without
   * developer mode). Checking out a link then writes a text file containing the target,
   * which is worse than not touching it, so those paths are reported as skipped.
   */
  symlinksSupported?: boolean
}

function keepChange(
  change: ChangeEntry,
  config: SyncConfig,
  ignore: IgnoreMatcher,
  skipped: SkippedEntry[],
  symlinksSupported: boolean,
): boolean {
  if (change.objectType === 'link' && !symlinksSupported) {
    skipped.push({
      path: change.path,
      reason: 'symlink-unsupported',
      detail: '本仓库 core.symlinks=false，检出符号链接只会写出一个文本文件；启用开发者模式或改为 true 后重试',
    })
    return false
  }
  if (ignore.isIgnored(change.path, false)) {
    skipped.push({ path: change.path, reason: 'ignored' })
    return false
  }
  if (config.includeFileTypes.length > 0 && !config.includeFileTypes.includes(extensionOf(change.path))) {
    skipped.push({ path: change.path, reason: 'file-type' })
    return false
  }
  // `keep` promises the local files upstream dropped stay put; `ask` decides after the plan is
  // printed (see protectPlanDeletes), so it plans the deletion like `mirror` does.
  if (change.kind === ChangeKind.DELETE && config.deletePolicy === 'keep') {
    skipped.push({
      path: change.path,
      reason: 'delete-protected',
      detail: 'deletePolicy 为 keep：上游已删除该文件，但本地文件保留；改用 mirror 才会同步删除',
    })
    return false
  }
  return true
}

/**
 * Move every planned deletion of a plan into the skipped list — the answer to `deletePolicy: 'ask'`
 * when the answer was "no". Purely functional: the caller keeps the original plan for logging.
 */
export function protectPlanDeletes(plan: SyncPlan, detail: string): SyncPlan {
  const protectedPaths = plan.changes.filter(entry => entry.kind === ChangeKind.DELETE)
  if (protectedPaths.length === 0)
    return plan
  return {
    ...plan,
    changes: plan.changes.filter(entry => entry.kind !== ChangeKind.DELETE),
    conflicts: plan.conflicts.filter(conflict => !protectedPaths.some(entry => entry.path === conflict.path)),
    skipped: [
      ...plan.skipped,
      ...protectedPaths.map(entry => ({ path: entry.path, reason: 'delete-protected' as const, detail })),
    ],
  }
}

export function plannedDeletes(plan: SyncPlan): number {
  return plan.changes.filter(entry => entry.kind === ChangeKind.DELETE).length
}

/**
 * Build the change list from the object database: upstream revision vs the target branch,
 * minus ignored paths, minus already-synced blobs, plus the paths that need conflict handling.
 */
export async function buildPlan(context: PlanContext): Promise<SyncPlan> {
  const { git, config, upstreamRef, ignore, state } = context
  const symlinksSupported = context.symlinksSupported ?? true
  const scopes = config.syncDirs
  const skipped: SkippedEntry[] = []

  const [upstreamTree, targetTree] = await Promise.all([
    git.listTree(upstreamRef, scopes),
    git.listTree(config.companyBranch, scopes),
  ])

  // Submodules are recorded rather than dropped: a synced `.gitmodules` whose gitlinks
  // were ignored leaves the target branch declaring modules it does not have.
  for (const { path } of gitlinkPaths(targetTree, upstreamTree)) {
    skipped.push({
      path,
      reason: 'submodule',
      detail: '子模块（gitlink）无法按文件同步，请在目标仓库手动 git submodule add/update',
    })
  }

  const kept: ChangeEntry[] = []
  for (const change of diffTrees(targetTree, upstreamTree, scopes)) {
    if (!keepChange(change, config, ignore, skipped, symlinksSupported))
      continue
    if (!config.forceOverwrite && state && change.upstreamOid && state.isSynced(change.path, change.upstreamOid, change.upstreamMode)) {
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

  // Folding happens after the ignore/state filters on purpose: a pair whose halves did not both
  // survive filtering has nothing to move, and stays the plain delete+add it was computed as.
  const renamed = config.renameDetection
    ? await git.renamedPaths(config.companyBranch, upstreamRef, scopes, config.renameThreshold)
    : []
  const entries = foldRenames(kept, renamed)

  const conflicts: ConflictCandidate[] = []
  for (const change of entries) {
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
    else if (change.kind === ChangeKind.RENAME) {
      // Two ways a move can hurt: the local file at the old path has edits we are about to
      // overwrite, or the destination path is already occupied by something git never saw.
      if (change.fromPath && modifiedSet.has(change.fromPath) && renameNeedsContent(change)) {
        conflicts.push({
          path: change.path,
          conflictType: ConflictType.DELETE_MODIFY,
          localOid: change.targetOid,
          upstreamOid: change.upstreamOid,
        })
      }
      else if (untrackedSet.has(change.path)) {
        conflicts.push({
          path: change.path,
          conflictType: ConflictType.UNTRACKED_OVERWRITE,
          upstreamOid: change.upstreamOid,
        })
      }
    }
  }

  const conflictPaths = new Set(conflicts.map(conflict => conflict.path))
  conflicts.push(...typeConflicts(entries, targetTree, upstreamTree, conflictPaths))

  if (conflicts.length > 0) {
    await attachBaseOids(git, config, upstreamRef, conflicts)
  }

  return {
    upstreamRef,
    targetBranch: config.companyBranch,
    changes: entries,
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
    if ((change.kind === ChangeKind.ADD || change.kind === ChangeKind.MODIFY || change.kind === ChangeKind.RENAME)
      && hasChildren(targetTree, change.path)) {
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
