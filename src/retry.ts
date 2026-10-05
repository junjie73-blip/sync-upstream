import { NetworkError, TimeoutError, toError } from './errors'
import { logger } from './logger'

export interface RetryConfig {
  maxRetries: number
  initialDelay: number
  backoffFactor: number
}

export interface RetryOptions extends RetryConfig {
  /** Decides whether a failure is worth another attempt; defaults to the transient-error pattern. */
  isRetryable?: (error: Error) => boolean
}

const DEFAULT_RETRYABLE = /网络|network|connect|resolve host|timed out|timeout|reset|closed|RPC failed|early EOF|无法访问|不可达/i

function delayFor(config: RetryConfig, attempt: number): number {
  return Math.round(config.initialDelay * config.backoffFactor ** (attempt - 1))
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
  })
}

/**
 * Retry a transient operation with exponential backoff. Non-retryable failures and the
 * exhausted-retry case keep the original error type, so `exitCodeFor` still classifies them.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const isRetryable = options.isRetryable ?? (error => DEFAULT_RETRYABLE.test(error.message))
  let lastError: Error | undefined

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      return await fn()
    }
    catch (error) {
      const current = toError(error)
      if (!isRetryable(current))
        throw current
      lastError = current

      if (attempt === options.maxRetries)
        break
      const delay = delayFor(options, attempt + 1)
      logger.warn(`第 ${attempt + 1}/${options.maxRetries} 次重试，${delay}ms 后继续: ${current.message}`)
      await wait(delay)
    }
  }

  const message = `重试 ${options.maxRetries} 次后仍然失败: ${lastError?.message ?? '未知原因'}`
  return Promise.reject(/超时|timeout/i.test(lastError?.message ?? '')
    ? new TimeoutError(message, lastError)
    : new NetworkError(message, lastError))
}

export { DEFAULT_RETRYABLE as TRANSIENT_ERROR_PATTERN }
