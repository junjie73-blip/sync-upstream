import type { SyncConfig } from '../domain'
import type { GitRepository } from '../git/repository'
import type { SyncHistoryRecord } from './sync-state'
import path from 'node:path'
import { logger } from '../logger'
import { sourcesOf } from './sources'
import { SyncState } from './sync-state'

export interface UndoContext {
  git: GitRepository
  config: SyncConfig
  repoRoot: string
}

export interface UndoResult {
  reverted: boolean
  /** The commit that was stepped back over. */
  target?: string
  /** New revert commit on top of it. */
  commit?: string
  branch?: string
  files: number
  /** Why nothing happened; also the reason `reverted: false` is not always an error. */
  reason?: string
}

function shorten(hash: string): string {
  return hash ? hash.slice(0, 8) : '(未知)'
}

/**
 * The newest record across every state file this config touches, with the state it came from.
 * Under fan-in each upstream keeps its own history, and the last one to commit owns HEAD —
 * so "the most recent sync" is a question about timestamps, not about one fixed file.
 */
async function newestRecord(
  repoRoot: string,
  config: SyncConfig,
): Promise<{ record: SyncHistoryRecord, state: SyncState } | null> {
  let newest: { record: SyncHistoryRecord, state: SyncState } | null = null
  for (const source of sourcesOf(config)) {
    const state = await SyncState.load(path.join(repoRoot, source.stateFile), {
      upstreamRepo: source.repo,
      upstreamBranch: source.ref,
      companyBranch: config.companyBranch,
    })
    const record = state.history[0]
    if (!record?.commit)
      continue
    if (!newest || record.syncedAt >= newest.record.syncedAt)
      newest = { record, state }
  }
  return newest
}

/**
 * Step back over the most recent sync this tool recorded.
 *
 * `git revert` rather than `git reset`: the sync commit may already be pushed and pulled,
 * and rewriting a shared branch is not this tool's call to make. Undo therefore only works
 * while the recorded commit is still HEAD — anything newer is the user's own work, and the
 * message says so instead of guessing.
 */
export async function undoLastSync(context: UndoContext): Promise<UndoResult> {
  const { git, config, repoRoot } = context
  const found = await newestRecord(repoRoot, config)
  const record = found?.record

  if (!found || !record?.commit) {
    return {
      reverted: false,
      files: 0,
      reason: '状态文件里没有可撤销的同步记录（旧版本或首次同步之前的运行不会记录）',
    }
  }
  const { state } = found

  const current = await git.currentBranch()
  if (record.branch && current !== record.branch) {
    if (!(await git.branchExists(record.branch)))
      return { reverted: false, files: 0, target: record.commit, reason: `记录中的分支 ${record.branch} 已不存在，无法确定撤销范围` }
    logger.info(`切换到同步记录所在分支 ${record.branch}（原分支 ${current}）`)
    await git.checkout(record.branch)
  }

  const head = await git.head()
  if (head !== record.commit) {
    return {
      reverted: false,
      files: record.paths.length,
      target: record.commit,
      branch: record.branch,
      reason: `最近一次同步是 ${shorten(record.commit)}，但 ${record.branch} 的 HEAD 已是 ${shorten(head)}。`
        + ` 为避免改写你自己的提交，请手工执行 git revert ${record.commit}`,
    }
  }

  const commit = await git.revertHead()
  // Forget the paths so the next sync stops treating them as already upstream.
  state.forget(record.paths)
  state.popSyncCommit()
  await state.save()

  return {
    reverted: true,
    target: record.commit,
    commit,
    branch: record.branch,
    files: record.paths.length,
  }
}
