import type { NotifyEvent } from '../domain'
import { redacted } from '../git/url'

const OUTCOME_LABEL: Record<NotifyEvent['outcome'], string> = {
  success: '同步成功',
  noop: '无变更',
  conflict: '同步完成（含冲突）',
  failure: '同步失败',
  undo: '已撤销同步',
}

function duration(ms: number): string {
  if (ms < 1000)
    return `${ms}ms`
  if (ms < 60_000)
    return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

/** The variables a `notifyConfig.template` may reference. */
export function eventPlaceholders(event: NotifyEvent): Record<string, string> {
  return {
    outcome: OUTCOME_LABEL[event.outcome],
    upstream: redacted(event.upstreamRepo),
    upstreamBranch: event.upstreamBranch,
    companyBranch: event.companyBranch,
    commit: event.commit ?? '-',
    files: String(event.applied ?? 0),
    kept: String(event.keptLocal ?? 0),
    conflicts: String(event.conflicts ?? 0),
    skipped: String(event.skipped ?? 0),
    error: event.error ?? '-',
    duration: duration(event.durationMs),
    dirs: event.syncDirs.join(', '),
    prBranch: event.pr?.branch ?? '-',
    prUrl: event.pr?.url ?? '-',
  }
}

function applyTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole)
}

/**
 * Plain-text body shared by every channel: chat providers all render text, and a message
 * that survives being pasted into a terminal is a message that survives Slack edit-time.
 */
export function renderEvent(event: NotifyEvent, template?: string, includeDetails = true): string {
  const values = eventPlaceholders(event)
  if (template)
    return applyTemplate(template, values)

  const lines = [
    `[sync-upstream] ${values.outcome}`,
    `分支: ${event.upstreamBranch} → ${event.companyBranch}`,
  ]
  if (event.outcome !== 'failure')
    lines.push(`变更 ${values.files} 个文件 · 保留本地 ${values.kept} · 冲突 ${values.conflicts} · 跳过 ${values.skipped}`)
  if (event.commit)
    lines.push(`提交: ${event.commit}`)
  if (event.pr) {
    lines.push(event.pr.pushed
      ? `PR 分支: ${event.pr.branch}（目标 ${event.pr.baseBranch} 未改动）${event.pr.created ? ' 已创建 PR' : ''}`
      : `PR 分支 ${event.pr.branch} 未推送，改动只在本地`)
    if (event.pr.url)
      lines.push(`评审入口: ${event.pr.url}`)
  }
  if (event.error)
    lines.push(`原因: ${event.error}`)
  if (includeDetails && event.sample && event.sample.length > 0)
    lines.push(`示例: ${event.sample.slice(0, 5).join(', ')}`)
  lines.push(`上游: ${values.upstream}`, `耗时 ${values.duration} · ${event.cwd}`)
  return lines.join('\n')
}
