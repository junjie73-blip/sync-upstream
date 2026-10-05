import type {
  ApplyResult,
  ChangeEntry,
  CommitResult,
  GrayReleaseStatus,
  RepoPath,
  SyncPlan,
} from '../domain'
import { bold, cyan, gray, green, magenta, red, yellow } from 'picocolors'
import { ChangeKind } from '../domain'

const KIND_MARK: Record<ChangeKind, { mark: string, color: (value: string) => string }> = {
  [ChangeKind.ADD]: { mark: '+', color: green },
  [ChangeKind.MODIFY]: { mark: '~', color: yellow },
  [ChangeKind.DELETE]: { mark: '-', color: red },
}

const SKIP_LABEL: Record<string, string> = {
  'ignored': '被忽略规则排除',
  'file-type': '文件类型不在白名单',
  'already-synced': '已是最新',
  'outside-sync-dirs': '不在同步目录内',
}

function line(entry: ChangeEntry): string {
  const { mark, color } = KIND_MARK[entry.kind]
  return `${color(bold(mark))} ${entry.path} ${gray(`(${entry.scope})`)}`
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
