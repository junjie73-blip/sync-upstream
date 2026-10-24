import type { ApplyResult, CommitResult, SyncPlan } from '../domain'
import type { SourceRunResult, SyncRunResult } from '../pipeline/orchestrator'
import type { CommandReport, SyncReportData, SyncSourceReport } from './types'
import { planSummary } from '../domain'
import { failedChanges } from '../pipeline/apply'
import { toReport } from './output'

/**
 * The plan the run just consumed, flattened for scripts. Commit-gap counts are left null:
 * they describe the state before the run, and `status` is the command that reports them.
 */
export function planFactsOf(plan: SyncPlan): SyncReportData['plan'] {
  return {
    summary: planSummary(plan),
    changes: plan.changes,
    conflicts: plan.conflicts.map(conflict => ({ path: conflict.path, conflictType: conflict.conflictType })),
    skipped: plan.skipped.map(item => ({ path: item.path, reason: item.reason, ...(item.detail ? { detail: item.detail } : {}) })),
    dirty: plan.dirty,
    upstreamCommitsAhead: null,
    targetCommitsAhead: null,
  }
}

function appliedFacts(applied: ApplyResult | undefined): SyncReportData['applied'] {
  return {
    applied: applied?.applied.filter(item => item.status === 'applied').length ?? 0,
    keptTarget: applied?.applied.filter(item => item.status === 'kept-target').length ?? 0,
    failed: applied ? failedChanges(applied).length : 0,
    list: applied?.applied.map(item => ({
      path: item.entry.path,
      status: item.status,
      ...(item.error ? { error: item.error } : {}),
    })) ?? [],
  }
}

function commitFacts(commit: CommitResult | undefined): SyncReportData['commit'] {
  return {
    created: commit?.created ?? false,
    ...(commit?.hash ? { hash: commit.hash } : {}),
    files: commit?.stagedCount ?? 0,
    ...(commit?.reason ? { reason: commit.reason } : {}),
  }
}

/** What one upstream contributed; `status`/`history` use the same labels. */
export function sourceFactsOf(item: SourceRunResult): SyncSourceReport {
  return {
    label: item.label,
    repo: item.repo,
    ref: item.ref,
    kind: item.kind,
    remote: item.remote,
    stateFile: item.stateFile,
    plan: planFactsOf(item.plan),
    applied: appliedFacts(item.applied),
    commit: commitFacts(item.commit),
    previewed: item.previewed,
    ...(item.lfs ? { lfs: item.lfs } : {}),
  }
}

export function buildSyncReport(
  result: SyncRunResult,
  options: { exitCode: number, warnings?: string[] },
): CommandReport<SyncReportData> {
  const applied = result.applied
  const data: SyncReportData = {
    previewed: result.previewed,
    startedOn: result.startedOn,
    endedOn: result.endedOn,
    plan: planFactsOf(result.plan),
    applied: appliedFacts(applied),
    commit: commitFacts(result.commit),
    failed: applied ? failedChanges(applied).map(item => ({ path: item.entry.path, error: item.error ?? '未知错误' })) : [],
    ...(result.gray ? { gray: { releaseId: result.gray.releaseId, stage: result.gray.stage, progress: result.gray.progress } } : {}),
    ...(result.pullRequest ? { pullRequest: result.pullRequest } : {}),
    ...(result.lfs ? { lfs: result.lfs } : {}),
    sources: result.sources.map(sourceFactsOf),
  }

  return toReport('sync', data, {
    ok: options.exitCode === 0,
    exitCode: options.exitCode,
    warnings: options.warnings ?? [],
    summary: syncMarkdown(data, result.plan.upstreamRef, result.plan.targetBranch),
  })
}

export function syncMarkdown(data: SyncReportData, upstreamRef: string, targetBranch: string): string {
  const lines = [
    data.commit.created ? '### sync-upstream: 已同步' : '### sync-upstream: 未产生提交',
    '',
    ...(data.sources.length > 1
      ? data.sources.map(item => `- 源 \`${item.label}\`（${item.kind}）→ 目标 \`${targetBranch}\`：${item.commit.created ? `提交 \`${item.commit.hash?.slice(0, 8) ?? ''}\`` : item.commit.reason ?? '无变更'}`)
      : [`- 源 \`${upstreamRef}\` → 目标 \`${targetBranch}\``]),
    `- 计划：新增 ${data.plan.summary.add}、修改 ${data.plan.summary.modify}、重命名 ${data.plan.summary.rename}、删除 ${data.plan.summary.delete}、冲突 ${data.plan.summary.conflict}、跳过 ${data.plan.summary.skipped}`,
    `- 应用：成功 ${data.applied.applied}、保留本地 ${data.applied.keptTarget}、失败 ${data.applied.failed}`,
  ]
  if (data.pullRequest) {
    const pr = data.pullRequest
    lines.push(`- PR 模式：分支 \`${pr.branch}\`（${pr.pushed ? `已推送 ${pr.remote}/${pr.branch}` : '未推送'}），目标分支 \`${pr.baseBranch}\` 未改动`)
    if (pr.created)
      lines.push(`- 已创建 PR：${pr.url ?? `（由 ${pr.tool} 创建）`}`)
    else if (pr.url)
      lines.push(`- 创建 PR：${pr.url}`)
    if (pr.note)
      lines.push(`- 提示：${pr.note}`)
  }
  if (data.lfs) {
    const lfs = data.lfs
    lines.push(
      lfs.materialized.length > 0
        ? `- Git LFS：${lfs.pointers.length} 个指针文件，已取回 ${lfs.materialized.length} 个的真实内容`
        : `- Git LFS：${lfs.pointers.length} 个文件同步的是指针文本（策略 \`${lfs.mode}\`）`,
    )
    if (lfs.note)
      lines.push(`  - 提示：${lfs.note}`)
  }
  if (data.commit.created)
    lines.push(`- 提交：\`${data.commit.hash?.slice(0, 8) ?? ''}\`（${data.commit.files} 个文件）`)
  else if (data.commit.reason)
    lines.push(`- 未提交原因：${data.commit.reason}`)
  if (data.startedOn && data.endedOn && data.startedOn !== data.endedOn)
    lines.push(`- 分支：运行前 \`${data.startedOn}\`，结束时 \`${data.endedOn}\``)
  if (data.failed.length > 0) {
    lines.push('', '#### 失败文件')
    for (const failure of data.failed.slice(0, 20)) lines.push(`- \`${failure.path}\`：${failure.error}`)
  }
  if (data.plan.conflicts.length > 0) {
    lines.push('', '#### 冲突文件')
    for (const conflict of data.plan.conflicts.slice(0, 20)) lines.push(`- \`${conflict.path}\`（${conflict.conflictType}）`)
  }
  return lines.join('\n')
}
