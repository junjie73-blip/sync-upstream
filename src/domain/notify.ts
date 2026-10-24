import type { RetryConfig } from './retry'

/** Where a sync result is announced. `stdout` is the log line; the rest are HTTP POSTs. */
export enum NotifyChannel {
  STDOUT = 'stdout',
  HTTP = 'http',
  SLACK = 'slack',
  DINGTALK = 'dingtalk',
  WECOM = 'wecom',
}

/**
 * What just happened. `noop` is a run whose plan came back empty — deliberately not
 * notified by default, because a daemon on a busy repository would post on every push.
 */
export type SyncOutcome = 'success' | 'noop' | 'conflict' | 'failure' | 'undo'

export const NOTIFY_CHANNELS: string[] = Object.values(NotifyChannel)
export const SYNC_OUTCOMES: string[] = ['success', 'noop', 'conflict', 'failure', 'undo']

export interface NotifyConfig {
  enable: boolean
  /** Channels to fan out to. A channel without its URL is skipped, not an error. */
  channels: NotifyChannel[]
  /** Generic endpoint: one JSON POST per event, with `headers` applied. */
  url?: string
  /** Extra request headers, e.g. `{ authorization: 'Bearer …' }`. */
  headers?: Record<string, string>
  slackUrl?: string
  dingtalkUrl?: string
  /** DingTalk 机器人的“加签”密钥；没有它投递会被拒。 */
  dingtalkSecret?: string
  wecomUrl?: string
  /** Outcomes that fire; defaults to everything except `noop`. */
  events: SyncOutcome[]
  /** Per-request ceiling in ms. A dead endpoint must not hold the CLI open. */
  timeoutMs: number
  /** Attempts per channel, on top of the sync's own retry policy. */
  retries: number
  /**
   * Message template. Placeholders: {outcome} {upstream} {upstreamBranch} {companyBranch}
   * {commit} {files} {kept} {conflicts} {skipped} {error} {duration}。
   */
  template?: string
  /** Attach the per-file summary lines. Default true. */
  includeDetails?: boolean
  /** Reused shape of the sync retry policy: only `maxRetries`/`initialDelay` matter here. */
  retryConfig?: RetryConfig
}

export interface NotifyEvent {
  outcome: SyncOutcome
  /** Redacted — never a token-bearing URL. */
  upstreamRepo: string
  upstreamBranch: string
  companyBranch: string
  syncDirs: string[]
  startedAt: string
  durationMs: number
  commit?: string
  applied?: number
  keptLocal?: number
  conflicts?: number
  skipped?: number
  /** Up to a few paths, so a notification is actionable without being a log dump. */
  sample?: string[]
  /**
   * Set when the run was a pull request: the target branch did not move, so a reviewer has to
   * open this branch instead — without it the message would announce work nobody can merge.
   */
  pr?: { branch: string, baseBranch: string, pushed: boolean, created?: boolean, url?: string | null }
  error?: string
  /** Where the run happened; useful when one bot serves many repositories. */
  cwd: string
}

export interface NotifyResult {
  channel: NotifyChannel
  ok: boolean
  /** HTTP status for the remote channels. */
  status?: number
  /** Human-readable reason; provider body or error message. */
  detail?: string
  attempts: number
}
