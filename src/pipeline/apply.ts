import type { Limit } from '../concurrency'
import type {
  AppliedChange,
  ApplyResult,
  ChangeEntry,
  ConflictDecision,
  RenamePair,
  RepoPath,
  SyncPlan,
} from '../domain'
import type { GitRepository } from '../git/repository'
import path from 'node:path'
import fs from 'fs-extra'
import { createLimit } from '../concurrency'
import { ChangeKind, ConflictType } from '../domain'
import { toError } from '../errors'
import { joinRepoPath } from '../fsx/paths'
import { t } from '../i18n'
import { renameNeedsContent } from './renames'

export interface ApplyContext {
  git: GitRepository
  upstreamRef: string
  repoRoot: string
  plan: SyncPlan
  /** Decisions for conflicted paths; a path missing here is applied unconditionally. */
  decisions: Map<RepoPath, ConflictDecision>
  /** How many single-path retries to run at once when a batch call fails. */
  concurrencyLimit?: number
}

interface Classification {
  applied: AppliedChange[]
  toWrite: ChangeEntry[]
  toRemove: ChangeEntry[]
  /** Upstream renamed these paths; `git mv` keeps history and any local edits. */
  toMove: ChangeEntry[]
  /** Upstream file that currently is a local directory; the tree must go first. */
  toUnset: RepoPath[]
  merged: Array<{ path: RepoPath, content: string }>
}

/** The pair a RENAME entry carries, as the git layer wants it. */
function pairOf(entry: ChangeEntry): RenamePair {
  return { from: entry.fromPath as RepoPath, to: entry.path, similarity: entry.similarity ?? 100 }
}

function typeConflictPaths(plan: SyncPlan): Set<RepoPath> {
  const paths = new Set<RepoPath>()
  for (const conflict of plan.conflicts) {
    if (conflict.conflictType === ConflictType.TYPE && conflict.upstreamOid)
      paths.add(conflict.path)
  }
  return paths
}

/**
 * Deletions the operator was explicitly asked about: the file had local edits and a DELETE_MODIFY
 * conflict was raised, so reaching the apply stage means "remove it anyway". Without `-f` here
 * `git rm` refuses the whole batch and the file survives the decision that was just made.
 */
function overriddenDeletes(plan: SyncPlan): Set<RepoPath> {
  const paths = new Set<RepoPath>()
  for (const conflict of plan.conflicts) {
    if (conflict.conflictType === ConflictType.DELETE_MODIFY)
      paths.add(conflict.path)
  }
  return paths
}

function classify(context: ApplyContext): Classification {
  const { plan, decisions } = context
  const unshelved = typeConflictPaths(plan)
  const result: Classification = { applied: [], toWrite: [], toRemove: [], toMove: [], toUnset: [], merged: [] }

  for (const entry of plan.changes) {
    const decision = decisions.get(entry.path)

    if (decision && (decision.action === 'keep-local' || decision.action === 'skip')) {
      result.applied.push({ entry, status: 'kept-target', error: decision.detail })
      continue
    }

    if (entry.kind === ChangeKind.DELETE) {
      result.toRemove.push(entry)
      continue
    }

    // A rename is one operation, not a delete plus an add: the old path goes, the new path
    // holds the content, and both halves succeed or fail together.
    if (entry.kind === ChangeKind.RENAME) {
      if (unshelved.has(entry.path))
        result.toUnset.push(entry.path)
      result.toMove.push(entry)
      if (decision?.action === 'write-merged' && decision.mergedContent !== undefined)
        result.merged.push({ path: entry.path, content: decision.mergedContent })
      continue
    }

    if (unshelved.has(entry.path))
      result.toUnset.push(entry.path)
    result.toWrite.push(entry)
    if (decision?.action === 'write-merged' && decision.mergedContent !== undefined) {
      result.merged.push({ path: entry.path, content: decision.mergedContent })
    }
  }

  return result
}

/**
 * Apply a plan with git itself: `checkout <ref> -- <paths>` for adds and modifies
 * (binary safe and staged in one step), `git mv` for upstream renames, `git rm` for deletions.
 */
export async function applyChanges(context: ApplyContext): Promise<ApplyResult> {
  const { git, repoRoot, upstreamRef, plan } = context
  const limit = createLimit(context.concurrencyLimit ?? 5)
  const { applied, toWrite, toRemove, toMove, toUnset, merged } = classify(context)

  // A local directory blocking an upstream file makes plain `checkout` fail, so clear it first.
  if (toUnset.length > 0)
    await git.removeRecursive(toUnset)

  await runBatch(
    applied,
    toMove,
    async () => {
      await git.renamePaths(toMove.filter(entry => entry.fromPath).map(pairOf))
      const fills = toMove.filter(entry => renameNeedsContent(entry) && entry.fromPath).map(entry => entry.path)
      if (fills.length > 0)
        await git.checkoutPathsFromRef(upstreamRef, fills)
    },
    async (entry) => {
      if (!entry.fromPath)
        throw new Error(t('e.renameNoFrom', { path: entry.path }))
      await git.renamePaths([pairOf(entry)])
      if (renameNeedsContent(entry))
        await git.checkoutPathsFromRef(upstreamRef, [entry.path])
    },
    limit,
  )

  await runBatch(
    applied,
    toWrite,
    () => git.checkoutPathsFromRef(upstreamRef, toWrite.map(entry => entry.path)),
    entry => git.checkoutPathsFromRef(upstreamRef, [entry.path]),
    limit,
  )

  for (const item of merged) {
    const target = joinRepoPath(repoRoot, item.path)
    // A merged rename lands on the new path, which only exists after the `git mv` above.
    const entry = [...toWrite, ...toMove].find(candidate => candidate.path === item.path)
    // Writing the merge result onto a path whose move failed would invent a half-applied rename.
    const blocked = applied.some(change => change.status === 'failed' && change.entry.path === item.path)
    if (blocked)
      continue
    try {
      await fs.ensureDir(path.dirname(target))
      await fs.writeFile(target, item.content, 'utf8')
      await git.addPaths([item.path])
    }
    catch (error) {
      if (entry)
        applied.push({ entry, status: 'failed', error: toError(error).message })
    }
  }

  // Plain upstream deletions go without `-f`: anything the tool did not plan to touch stays.
  // The paths that raised a DELETE_MODIFY conflict are here because the operator chose to follow
  // upstream anyway, and `git rm` must actually remove them instead of refusing the batch.
  const overridden = overriddenDeletes(plan)
  const plainDeletes = toRemove.filter(entry => !overridden.has(entry.path))
  const forcedDeletes = toRemove.filter(entry => overridden.has(entry.path))

  await runBatch(
    applied,
    plainDeletes,
    () => git.removePaths(plainDeletes.map(entry => entry.path)),
    entry => git.removePaths([entry.path]),
    limit,
  )

  await runBatch(
    applied,
    forcedDeletes,
    () => git.removePaths(forcedDeletes.map(entry => entry.path), { force: true }),
    entry => git.removePaths([entry.path], { force: true }),
    limit,
  )

  return { applied, stagedPaths: await git.stagedPaths() }
}

/** Run the batch once; on failure retry per path (bounded by `taskLimit`) so one bad file cannot hide the rest. */
async function runBatch(
  applied: AppliedChange[],
  entries: ChangeEntry[],
  batch: () => Promise<void>,
  single: (entry: ChangeEntry) => Promise<void>,
  taskLimit: Limit,
): Promise<void> {
  if (entries.length === 0)
    return

  try {
    await batch()
    for (const entry of entries) applied.push({ entry, status: 'applied' })
  }
  catch (error) {
    const groupFailure = toError(error).message
    await Promise.all(entries.map(entry => taskLimit(async () => {
      try {
        await single(entry)
        applied.push({ entry, status: 'applied' })
      }
      catch (singleError) {
        applied.push({
          entry,
          status: 'failed',
          error: `${groupFailure}; 单独重试失败: ${toError(singleError).message}`,
        })
      }
    })))
  }
}

export function failedChanges(result: ApplyResult): AppliedChange[] {
  return result.applied.filter(change => change.status === 'failed')
}

export function keptChanges(result: ApplyResult): AppliedChange[] {
  return result.applied.filter(change => change.status === 'kept-target')
}
