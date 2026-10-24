import type {
  ApplyResult,
  ChangeEntry,
  CommitResult,
  GrayReleaseStatus,
  LfsFacts,
  LfsMode,
  RepoPath,
  SyncPlan,
} from '../domain'
import type { PullRequestFacts } from './pr'
import type { UndoResult } from './undo'
import { bold, cyan, gray, green, magenta, red, yellow } from 'picocolors'
import { ChangeKind } from '../domain'

const KIND_MARK: Record<ChangeKind, { mark: string, color: (value: string) => string }> = {
  [ChangeKind.ADD]: { mark: '+', color: green },
  [ChangeKind.MODIFY]: { mark: '~', color: yellow },
  [ChangeKind.DELETE]: { mark: '-', color: red },
  [ChangeKind.RENAME]: { mark: '>', color: cyan },
}

const SKIP_LABEL: Record<string, string> = {
  'ignored': '被忽略规则排除',
  'file-type': '文件类型不在白名单',
  'already-synced': '已是最新',
  'outside-sync-dirs': '不在同步目录内',
  'submodule': '子模块（gitlink）无法按文件同步',
  'symlink-unsupported': '本地 core.symlinks=false，符号链接未写入',
  'delete-protected': '上游删除但被删除策略保留',
}

function line(entry: ChangeEntry): string {
  const { mark, color } = KIND_MARK[entry.kind]
  // A rename is only useful in the plan if the operator can see both halves of it.
  const where = entry.kind === ChangeKind.RENAME && entry.fromPath
    ? `${gray(entry.fromPath)} ${color('→')} ${entry.path} ${gray(`相似度 ${entry.similarity ?? 100}%`)}`
    : entry.path
  return `${color(bold(mark))} ${where} ${gray(`(${entry.scope})`)}`
}

/** What will happen, computed from the same plan the apply stage consumes. */
export function formatPlan(plan: SyncPlan, limit = 40): string[] {
  const lines: string[] = []
  lines.push(bold(cyan(`计划: ${plan.changes.length} 项变更 (源 ${plan.upstreamRef} → 目标 ${plan.targetBranch})`)))

  for (const entry of plan.changes.slice(0, limit)) lines.push(line(entry))
  if (plan.changes.length > limit) {
    lines.push(gray(`… 其余 ${plan.changes.length - limit} 项省略（完整列表见 --verbose）`))
  }

  if (plan.conflicts.length > 0) {
    lines.push(yellow(bold(`冲突: ${plan.conflicts.length} 个文件本地与上游都有改动`)))
    for (const conflict of plan.conflicts.slice(0, limit)) {
      lines.push(yellow(`  ! ${conflict.path} [${conflict.conflictType}]`))
    }
  }

  const skipped = groupByReason(plan.skipped)
  for (const [reason, paths] of skipped) {
    lines.push(magenta(`跳过 ${paths.length} 个文件 — ${SKIP_LABEL[reason] ?? reason}`))
  }

  if (plan.dirty.length > 0) {
    lines.push(gray(`本地已修改文件 ${plan.dirty.length} 个（仅同步目录内）`))
  }
  return lines
}

function groupByReason(skipped: SyncPlan['skipped']): Map<string, RepoPath[]> {
  const grouped = new Map<string, RepoPath[]>()
  for (const item of skipped) {
    const bucket = grouped.get(item.reason)
    if (bucket)
      bucket.push(item.path)
    else grouped.set(item.reason, [item.path])
  }
  return grouped
}

export function formatApplyResult(result: ApplyResult): string[] {
  const lines: string[] = []
  const counts = { 'applied': 0, 'kept-target': 0, 'failed': 0 }
  for (const change of result.applied) counts[change.status]++

  lines.push(bold(green(`应用完成: ${counts.applied} 个文件写入, ${counts['kept-target']} 个保留本地, ${counts.failed} 个失败`)))
  for (const change of result.applied.filter(item => item.status === 'failed')) {
    lines.push(red(`  x ${change.entry.path}: ${change.error}`))
  }
  return lines
}

export function formatCommitResult(result: CommitResult): string[] {
  if (!result.created)
    return [yellow(`未提交: ${result.reason ?? '没有变更'}`)]
  return [bold(green(`已提交 ${result.hash?.slice(0, 8)}（${result.stagedCount} 个文件）`))]
}

export function formatGrayStatus(status: GrayReleaseStatus): string[] {
  return [
    bold(cyan(`灰度发布 ${status.releaseId}`)),
    `  阶段: ${status.stage}  进度: ${status.progress}%`,
    `  文件: ${status.filesReleased}/${status.totalFiles}`,
    ...(status.errors.length > 0 ? status.errors.map(item => red(`  错误: ${item}`)) : []),
  ]
}

export function formatPrResult(facts: PullRequestFacts): string[] {
  const lines = [
    facts.pushed
      ? bold(green(`PR 分支已推送: ${facts.remote}/${facts.branch}`))
      : red(`PR 分支未推送: ${facts.remote}/${facts.branch}`),
    `  目标分支 ${facts.baseBranch} 未改动，等待评审合并`,
  ]
  if (facts.created)
    lines.push(bold(cyan(`  已通过 ${facts.tool ?? '平台 CLI'} 创建 PR: ${facts.url ?? '（请在平台上查看）'}`)))
  else if (facts.url)
    lines.push(`  打开此链接创建 PR: ${facts.url}`)
  else
    lines.push(gray(`  手动创建: git push ${facts.remote} ${facts.branch}，再从 ${facts.baseBranch} 发起 PR`))
  if (facts.note)
    lines.push(yellow(`  提示: ${facts.note}`))
  return lines
}

const LFS_MODE_WORD: Record<LfsMode, string> = {
  pointer: '保留指针文本',
  materialize: '取回真实内容',
  off: '不检测',
}

/**
 * What Git LFS meant for this run, in the operator's terms: which files are pointers, whether
 * their content arrived, and what to change if they wanted it to.
 */
export function formatLfsFacts(facts: LfsFacts): string[] {
  const shown = facts.pointers.slice(0, 10).map(item => `  ${item}`)
  if (facts.pointers.length > shown.length)
    shown.push(gray(`  …另外 ${facts.pointers.length - shown.length} 个`))

  if (facts.materialized.length > 0 && !facts.note) {
    return [
      bold(green(`已取回 ${facts.materialized.length} 个 Git LFS 文件的真实内容`)),
      ...shown,
    ]
  }

  const lines = [
    facts.materialized.length > 0
      ? yellow(`已取回 ${facts.materialized.length} 个 LFS 文件，其余 ${facts.pointers.length - facts.materialized.length} 个仍是指针`)
      : yellow(`${facts.pointers.length} 个同步文件由 Git LFS 管理，当前策略「${LFS_MODE_WORD[facts.mode]}」，落到本地的是指针文本而不是文件内容`),
    ...shown,
  ]
  if (facts.note)
    lines.push(red(`  取回失败：${facts.note}`))
  if (facts.mode !== 'materialize' && facts.materialized.length === 0)
    lines.push(gray('  需要真实内容：设置 fetchConfig.lfs = "materialize"（本机需安装 git-lfs，且上游 LFS 服务可达）'))
  return lines
}

export function formatUndoResult(result: UndoResult): string[] {
  if (!result.reverted)
    return [yellow(`未撤销: ${result.reason ?? '没有可撤销的同步记录'}`)]
  return [
    bold(green(`已撤销同步 ${result.target?.slice(0, 8)}（${result.files} 个文件）`)),
    `  撤销提交: ${result.commit?.slice(0, 8)} · 分支 ${result.branch}`,
    gray('  增量状态里这些路径已标记为未同步，下次同步会重新应用上游内容。'),
  ]
}
