import type { ApplyResult, CommitResult, RepoPath, SyncPlan } from '../domain'
import type { GitRepository } from '../git/repository'
import { ChangeKind } from '../domain'

export interface CommitContext {
  git: GitRepository
  plan: SyncPlan
  result: ApplyResult
  message: string
}

/** Paths this run was supposed to change; the commit may only touch these. */
function touchedPaths(plan: SyncPlan, result: ApplyResult): Set<RepoPath> {
  const touched = new Set(result.applied
    .filter(change => change.status === 'applied')
    .map(change => change.entry.path))
  // A successful `git rm` leaves no working-tree file, so take the deletions from the plan.
  for (const entry of plan.changes) {
    if (entry.kind === ChangeKind.DELETE)
      touched.add(entry.path)
  }
  return touched
}

/**
 * Commit exactly the paths this run applied. The previous implementation asked `git status`
 * whether anything was dirty, so untracked tool artifacts and unrelated local files
 * were reported as changes while `git commit` then failed with "nothing added to commit".
 *
 * The pathspec travels as the whole applied set, not as the staged list: git pairs an
 * identical delete + add into one rename entry, so `diff --cached --name-only` reports only
 * the destination and a pathspec built from it would silently leave the removed file behind.
 */
export async function commitChanges(context: CommitContext): Promise<CommitResult> {
  const { git, message } = context
  const candidates = touchedPaths(context.plan, context.result)

  const staged = (await git.stagedPaths()).filter(repoPath => candidates.has(repoPath))
  if (staged.length === 0) {
    return {
      created: false,
      stagedCount: 0,
      reason: context.plan.changes.length === 0
        ? '没有需要同步的变更，无需提交'
        : `计划中的 ${context.plan.changes.length} 项变更未产生暂存差异，目标分支已与上游一致`,
    }
  }

  const paths = [...candidates].sort()
  const hash = await git.commit(message, paths)
  return { created: true, hash, stagedCount: paths.length }
}

export interface PushContext {
  git: GitRepository
  remote: string
  branch: string
}

export async function pushChanges(context: PushContext): Promise<void> {
  await context.git.push(context.remote, context.branch)
}
