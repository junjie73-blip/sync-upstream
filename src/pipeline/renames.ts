import type { ChangeEntry, RenamePair } from '../domain'
import { ChangeKind } from '../domain'

/**
 * Fold git's rename pairs into the change list.
 *
 * Without this a rename is two unrelated changes: the old path is a DELETE and the new path an
 * ADD. Applying that to a target branch is both destructive (local edits on the old path are
 * thrown away) and misleading (the plan reads like upstream dropped half the directory). One
 * RENAME entry lets the apply stage `git mv` instead, which keeps history and local edits.
 *
 * Pairs are only folded when both halves are actually in the plan: a path the ignore rules or
 * the incremental state removed stays as it was, because the rename has nothing to move.
 */
export function foldRenames(changes: ChangeEntry[], renames: RenamePair[]): ChangeEntry[] {
  if (renames.length === 0)
    return changes

  const deletes = new Map(changes
    .filter(entry => entry.kind === ChangeKind.DELETE)
    .map(entry => [entry.path, entry] as const))
  const adds = new Map(changes
    .filter(entry => entry.kind === ChangeKind.ADD)
    .map(entry => [entry.path, entry] as const))

  const consumed = new Set<ChangeEntry>()
  const renamed: ChangeEntry[] = []

  for (const pair of renames) {
    const from = deletes.get(pair.from)
    const to = adds.get(pair.to)
    if (!from || !to || pair.from === pair.to)
      continue
    consumed.add(from)
    consumed.add(to)
    renamed.push({
      kind: ChangeKind.RENAME,
      path: to.path,
      scope: to.scope,
      fromPath: pair.from,
      similarity: pair.similarity,
      upstreamOid: to.upstreamOid,
      upstreamMode: to.upstreamMode,
      // The old path's committed blob: what the local file is when nothing touched it.
      targetOid: from.targetOid,
      targetMode: from.targetMode,
      objectType: to.objectType ?? from.objectType,
    })
  }

  if (renamed.length === 0)
    return changes
  return [...changes.filter(entry => !consumed.has(entry)), ...renamed]
    .sort((a, b) => a.path.localeCompare(b.path))
}

/** True when the renamed file also needs upstream's content written into the new path. */
export function renameNeedsContent(entry: ChangeEntry): boolean {
  if (entry.kind !== ChangeKind.RENAME)
    return false
  // Identical blobs mean a pure move: after `git mv` the content is already right.
  return entry.similarity !== 100 || entry.upstreamOid !== entry.targetOid
}
