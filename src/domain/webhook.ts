import type { RetryConfig } from './retry'

export type WebhookPlatform = 'github' | 'gitlab' | 'bitbucket' | 'gitea'

export interface WebhookRateLimit {
  maxRequestsPerSecond: number
  statusCode: number
  message: string
}

export interface WebhookSecurityConfig {
  ipWhitelist: string[]
  rateLimit: WebhookRateLimit
}

export interface WebhookEventFilterRule {
  eventType: string
  conditions: Array<{
    fieldPath: string
    operator: 'eq' | 'ne' | 'gt' | 'lt' | 'contains' | 'regex'
    value: unknown
  }>
}

export interface WebhookConfig {
  enable: boolean
  port: number
  path: string
  secret: string
  allowedEvents: string[]
  triggerBranch: string
  supportedPlatforms: WebhookPlatform[]
  retryConfig?: RetryConfig
  securityConfig?: WebhookSecurityConfig
  eventFilterConfig?: { rules: WebhookEventFilterRule[] }
  /**
   * Bind address. Defaults to `127.0.0.1`: a sync daemon that listens on every interface
   * by default is how an internal repository ends up reachable from the whole network.
   */
  host?: string
  /** Serve over HTTPS with this PEM certificate + key (see `tlsKey`). */
  tlsCert?: string
  tlsKey?: string
  /**
   * Only trust `x-forwarded-for` when the daemon really sits behind a proxy. Trusted
   * blindly, any caller can put a whitelisted address in that header and walk past
   * `ipWhitelist` and the per-IP rate limit.
   */
  trustProxy?: boolean
  /** Request body ceiling in bytes; defaults to 1 MiB. */
  maxBodyBytes?: number
  /** GET this path for a liveness probe; defaults to `/healthz`. Set to `false` to disable. */
  healthPath?: string | false
  /** Ignore deliveries whose provider id was already processed (default true). */
  deduplicate?: boolean
  /**
   * JSONL audit trail: one line per delivery with the decision and why.
   *
   * The signature check proves a delivery came from the platform; it does not answer "did my push
   * at 14:02 trigger a sync, and what did the daemon decide to do about it". Relative paths resolve
   * against the repository root. Absent means no audit file.
   */
  deliveryLog?: string
  /**
   * How many deliveries may wait for the repository lock at once. Default 8.
   *
   * Syncs serialise on the lock, so a burst of pushes does not corrupt anything — it just means
   * every delivery after the queue is full has nothing to look at but a 202 that never turns into
   * a sync. Refusing with 503 tells the platform to redeliver later instead.
   */
  maxQueue?: number
  /**
   * File holding the delivery ids already handled, so a restart does not accept a redelivery of
   * something the previous process finished. Defaults to `<deliveryLog>.seen.json`.
   */
  seenStateFile?: string
  /** How many ids that file keeps. Default 512. */
  seenHistory?: number
}

export interface WebhookDelivery {
  platform: WebhookPlatform
  event: string
  branch: string
  accepted: boolean
  reason?: string
  /** Provider delivery GUID, when the platform sent one; used for de-duplication. */
  deliveryId?: string
}
