import type { Limit } from '../concurrency'
import type {
  AppliedChange,
  ApplyResult,
  ChangeEntry,
  ConflictDecision,
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
  /** Upstream file that currently is a local directory; the tree must go first. */
  toUnset: RepoPath[]
  merged: Array<{ path: RepoPath, content: string }>
}

function typeConflictPaths(plan: SyncPlan): Set<RepoPath> {
  const paths = new Set<RepoPath>()
  for (const conflict of plan.conflicts) {
    if (conflict.conflictType === ConflictType.TYPE && conflict.upstreamOid)
      paths.add(conflict.path)
  }
  return paths
}

function classify(context: ApplyContext): Classification {
  const { plan, decisions } = context
  const unshelved = typeConflictPaths(plan)
  const result: Classification = { applied: [], toWrite: [], toRemove: [], toUnset: [], merged: [] }

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
 * (binary safe and staged in one step), `git rm` for upstream deletions.
 */
export async function applyChanges(context: ApplyContext): Promise<ApplyResult> {
  const { git, repoRoot, upstreamRef } = context
  const limit = createLimit(context.concurrencyLimit ?? 5)
  const { applied, toWrite, toRemove, toUnset, merged } = classify(context)

  // A local directory blocking an upstream file makes plain `checkout` fail, so clear it first.
  if (toUnset.length > 0)
    await git.removeRecursive(toUnset)

  await runBatch(
    applied,
    toWrite,
    () => git.checkoutPathsFromRef(upstreamRef, toWrite.map(entry => entry.path)),
    entry => git.checkoutPathsFromRef(upstreamRef, [entry.path]),
    limit,
  )

  for (const item of merged) {
    const target = joinRepoPath(repoRoot, item.path)
    const entry = toWrite.find(candidate => candidate.path === item.path)
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

  await runBatch(
    applied,
    toRemove,
    () => git.removePaths(toRemove.map(entry => entry.path)),
    entry => git.removePaths([entry.path]),
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
