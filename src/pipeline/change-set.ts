import type { ChangeEntry, RepoPath } from '../domain'
import type { GitObjectType, TreeEntry } from '../git/repository'
import { ChangeKind } from '../domain'
import { scopeOf } from '../fsx/paths'
import { isSyncableObject } from '../git/repository'

/**
 * Compare two revision trees restricted to the sync scopes. This replaces the old
 * "copy the working tree into .sync-temp and diff it against itself" staging, which
 * compared upstream against upstream and therefore reported every file as deleted.
 *
 * Symlinks take part like any other object (git materialises them on checkout); gitlinks
 * are excluded here and reported as skipped by the planner, which has the log to do that.
 */
export function diffTrees(
  target: Map<RepoPath, TreeEntry>,
  upstream: Map<RepoPath, TreeEntry>,
  scopes: RepoPath[],
): ChangeEntry[] {
  const changes: ChangeEntry[] = []

  for (const [repoPath, entry] of upstream) {
    const scope = scopeOf(repoPath, scopes)
    if (scope === null || !isSyncableObject(entry))
      continue
    const targetEntry = target.get(repoPath)
    if (!targetEntry) {
      changes.push({
        kind: ChangeKind.ADD,
        path: repoPath,
        scope,
        upstreamOid: entry.oid,
        upstreamMode: entry.mode,
        objectType: entry.type,
      })
      continue
    }
    if (targetEntry.oid !== entry.oid || targetEntry.mode !== entry.mode) {
      changes.push({
        kind: ChangeKind.MODIFY,
        path: repoPath,
        scope,
        upstreamOid: entry.oid,
        targetOid: targetEntry.oid,
        upstreamMode: entry.mode,
        targetMode: targetEntry.mode,
        objectType: entry.type,
      })
    }
  }

  for (const [repoPath, entry] of target) {
    if (upstream.has(repoPath) || !isSyncableObject(entry))
      continue
    const scope = scopeOf(repoPath, scopes)
    if (scope === null)
      continue
    changes.push({
      kind: ChangeKind.DELETE,
      path: repoPath,
      scope,
      targetOid: entry.oid,
      targetMode: entry.mode,
      objectType: entry.type,
    })
  }

  return changes.sort((a, b) => a.path.localeCompare(b.path))
}

/** Paths either side holds as a submodule gitlink, which no file-level sync can represent. */
export function gitlinkPaths(
  ...trees: Array<Map<RepoPath, TreeEntry>>
): Array<{ path: RepoPath, type: GitObjectType }> {
  const found = new Map<RepoPath, GitObjectType>()
  for (const tree of trees) {
    for (const [path, entry] of tree) {
      if (entry.type === 'commit')
        found.set(path, entry.type)
    }
  }
  return [...found].map(([path, type]) => ({ path, type }))
}

/** Paths the target branch has but upstream dropped entirely, grouped per scope. */
export function groupByScope(changes: ChangeEntry[]): Map<RepoPath, ChangeEntry[]> {
  const grouped = new Map<RepoPath, ChangeEntry[]>()
  for (const change of changes) {
    const bucket = grouped.get(change.scope)
    if (bucket)
      bucket.push(change)
    else grouped.set(change.scope, [change])
  }
  return grouped
}

export function countByKind(changes: ChangeEntry[]): Record<ChangeKind, number> {
  const counts: Record<ChangeKind, number> = {
    [ChangeKind.ADD]: 0,
    [ChangeKind.MODIFY]: 0,
    [ChangeKind.DELETE]: 0,
    [ChangeKind.RENAME]: 0,
  }
  for (const change of changes) counts[change.kind]++
  return counts
}
