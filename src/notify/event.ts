import type { ChangeEntry, NotifyConfig, NotifyEvent, SyncConfig } from '../domain'
import type { SyncRunResult } from '../pipeline/orchestrator'
import type { UndoResult } from '../pipeline/undo'
import process from 'node:process'
import { ChangeKind } from '../domain'
import { toError } from '../errors'
import { redacted } from '../git/url'
import { sourcesOf } from '../pipeline/sources'

/** How many paths a notification quotes before it stops being a summary. */
const SAMPLE_LIMIT = 8

function base(config: SyncConfig, startedAt: number): Pick<NotifyEvent, 'upstreamRepo' | 'upstreamBranch' | 'companyBranch' | 'syncDirs' | 'startedAt' | 'durationMs' | 'cwd'> {
  // Under fan-in one run is several upstreams; a chat message that names only the first one
  // would describe a run that never happened. One source renders exactly like before.
  const sources = sourcesOf(config)
  return {
    // Credentials in a remote URL must never reach a chat webhook.
    upstreamRepo: sources.map(item => redacted(item.repo)).join(' + '),
    upstreamBranch: sources.map(item => item.ref).join(' + '),
    companyBranch: config.companyBranch,
    syncDirs: [...new Set(sources.flatMap(item => item.dirs))],
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Math.max(0, Date.now() - startedAt),
    cwd: process.cwd(),
  }
}

/** One change, in the `+`/`~`/`-`/`>` shorthand a chat message can carry. */
function labelOf(entry: ChangeEntry): string {
  if (entry.kind === ChangeKind.MODIFY)
    return `~ ${entry.path}`
  if (entry.kind === ChangeKind.ADD)
    return `+ ${entry.path}`
  if (entry.kind === ChangeKind.RENAME)
    return `> ${entry.fromPath ?? '?'} → ${entry.path}`
  return `- ${entry.path}`
}

function sample(result: SyncRunResult): string[] {
  const paths = [
    ...result.plan.changes.map(labelOf),
    ...result.plan.conflicts.map(conflict => `! ${conflict.path}`),
  ]
  return paths.slice(0, SAMPLE_LIMIT)
}

/** The run wrote something, kept something local, or failed to write — all of it matters. */
function counts(result: SyncRunResult): Pick<NotifyEvent, 'applied' | 'keptLocal' | 'conflicts' | 'skipped'> {
  const applied = result.applied
  return {
    applied: applied ? applied.applied.filter(item => item.status === 'applied').length : result.plan.changes.length,
    keptLocal: applied ? applied.applied.filter(item => item.status === 'kept-target').length : 0,
    conflicts: result.plan.conflicts.length + (result.decisions?.length ?? 0),
    skipped: result.plan.skipped.length,
  }
}

export function eventFromRun(config: SyncConfig, result: SyncRunResult, startedAt: number): NotifyEvent {
  const failures = result.applied?.applied.filter(item => item.status === 'failed') ?? []
  const nothingHappened = result.previewed || (result.plan.changes.length === 0 && failures.length === 0)
  return {
    ...base(config, startedAt),
    ...counts(result),
    outcome: failures.length > 0 ? 'failure' : nothingHappened ? 'noop' : result.plan.conflicts.length > 0 ? 'conflict' : 'success',
    ...(result.commit?.hash ? { commit: result.commit.hash } : {}),
    ...(result.pullRequest
      ? {
          pr: {
            branch: result.pullRequest.branch,
            baseBranch: result.pullRequest.baseBranch,
            pushed: result.pullRequest.pushed,
            ...(result.pullRequest.created ? { created: true } : {}),
            ...(result.pullRequest.url ? { url: result.pullRequest.url } : {}),
          },
        }
      : {}),
    ...(failures.length > 0 ? { error: failures.map(item => `${item.entry.path}: ${item.error ?? '写入失败'}`).join('; ') } : {}),
    sample: sample(result),
  }
}

export function eventFromUndo(config: SyncConfig, result: UndoResult, startedAt: number): NotifyEvent {
  return {
    ...base(config, startedAt),
    outcome: result.reverted ? 'undo' : 'noop',
    ...(result.commit ? { commit: result.commit } : {}),
    applied: result.files,
    ...(result.reverted ? {} : { error: result.reason ?? '没有可撤销的同步' }),
  }
}

export function eventFromFailure(config: SyncConfig, error: unknown, startedAt: number): NotifyEvent {
  return {
    ...base(config, startedAt),
    outcome: 'failure',
    error: toError(error).message,
  }
}

/**
 * Whether this event should be announced at all. Preview runs never notify: a webhook daemon
 * or CI job that only looked at the plan has nothing for the team to act on.
 */
export function notifyEnabled(config: NotifyConfig | undefined, outcome: NotifyEvent['outcome'], isPreview: boolean): boolean {
  if (!config?.enable || isPreview)
    return false
  const events = config.events && config.events.length > 0 ? config.events : ['success', 'conflict', 'failure', 'undo']
  return events.includes(outcome)
}
