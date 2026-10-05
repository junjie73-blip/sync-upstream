import type { RepoPath } from '../domain'
import type { GitRepository } from '../git/repository'
import type { GrayState } from './state'
import { logger } from '../logger'

export interface RollbackOutcome {
  restored: RepoPath[]
  removed: RepoPath[]
  commitHash?: string
  reason?: string
}

/**
 * Put the previously released paths back to how they looked in `baseCommit`:
 * files that existed there are checked out from it, files the release created are deleted.
 */
export async function rollbackRelease(
  git: GitRepository,
  state: GrayState,
  message: string,
): Promise<RollbackOutcome> {
  const baseCommit = state.baseCommit
  const paths = [...state.canaryPaths, ...state.pendingPaths]
  if (!baseCommit || !(await git.refExists(baseCommit))) {
    return { restored: [], removed: [], reason: '找不到灰度起始版本，无法回滚' }
  }
  if (paths.length === 0) {
    return { restored: [], removed: [], reason: '没有记录到已发布的文件，无需回滚' }
  }

  const baseTree = await git.listTree(baseCommit, paths)
  const restored: RepoPath[] = []
  const removed: RepoPath[] = []
  for (const repoPath of paths) {
    (baseTree.has(repoPath) ? restored : removed).push(repoPath)
  }

  if (restored.length > 0)
    await git.checkoutPathsFromRef(baseCommit, restored)
  if (removed.length > 0)
    await git.removePaths(removed)

  const touched = new Set([...restored, ...removed])
  const relevant = (await git.stagedPaths()).filter(repoPath => touched.has(repoPath))
  if (relevant.length === 0) {
    return { restored, removed, reason: '回滚未产生差异，工作区已与起始版本一致' }
  }

  const commitHash = await git.commit(message, relevant)
  state.advance(state.stage, { commitHash })
  logger.success(`灰度回滚完成: 恢复 ${restored.length} 个, 移除 ${removed.length} 个`)
  return { restored, removed, commitHash }
}
