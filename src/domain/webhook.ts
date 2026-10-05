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
}

export interface WebhookDelivery {
  platform: WebhookPlatform
  event: string
  branch: string
  accepted: boolean
  reason?: string
}
