import type { ChangeEntry, RepoPath } from '../domain'
import type { TreeEntry } from '../git/repository'
import { ChangeKind } from '../domain'
import { scopeOf } from '../fsx/paths'

/**
 * Compare two revision trees restricted to the sync scopes. This replaces the old
 * "copy the working tree into .sync-temp and diff it against itself" staging, which
 * compared upstream against upstream and therefore reported every file as deleted.
 */
export function diffTrees(
  target: Map<RepoPath, TreeEntry>,
  upstream: Map<RepoPath, TreeEntry>,
  scopes: RepoPath[],
): ChangeEntry[] {
  const changes: ChangeEntry[] = []

  for (const [repoPath, entry] of upstream) {
    const scope = scopeOf(repoPath, scopes)
    if (scope === null)
      continue
    const targetEntry = target.get(repoPath)
    if (!targetEntry) {
      changes.push({ kind: ChangeKind.ADD, path: repoPath, scope, upstreamOid: entry.oid })
      continue
    }
    if (targetEntry.oid !== entry.oid || targetEntry.mode !== entry.mode) {
      changes.push({
        kind: ChangeKind.MODIFY,
        path: repoPath,
        scope,
        upstreamOid: entry.oid,
        targetOid: targetEntry.oid,
      })
    }
  }

  for (const [repoPath, entry] of target) {
    if (upstream.has(repoPath))
      continue
    const scope = scopeOf(repoPath, scopes)
    if (scope === null)
      continue
    changes.push({ kind: ChangeKind.DELETE, path: repoPath, scope, targetOid: entry.oid })
  }

  return changes.sort((a, b) => a.path.localeCompare(b.path))
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
  }
  for (const change of changes) counts[change.kind]++
  return counts
}
