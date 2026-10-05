import { red, yellow } from 'picocolors'
import { logger } from './logger'

export enum ErrorCode {
  CONFIG = 'CONFIG_ERROR',
  VALIDATION = 'VALIDATION_ERROR',
  GIT = 'GIT_ERROR',
  REPO_PATH = 'REPO_PATH_ERROR',
  FS = 'FS_ERROR',
  NETWORK = 'NETWORK_ERROR',
  CONFLICT = 'CONFLICT_ERROR',
  AUTHENTICATION = 'AUTH_ERROR',
  PERMISSION = 'PERMISSION_ERROR',
  TIMEOUT = 'TIMEOUT_ERROR',
  SYNC_PROCESS = 'SYNC_PROCESS_ERROR',
  USER_CANCEL = 'USER_CANCEL',
}

export type ErrorSeverity = 'info' | 'warning' | 'error' | 'critical'

export abstract class SyncError extends Error {
  abstract readonly code: ErrorCode
  readonly severity: ErrorSeverity = 'error'
  readonly originalError?: Error
  readonly context?: Record<string, unknown>
  readonly timestamp: Date = new Date()

  constructor(message: string, originalError?: Error, context?: Record<string, unknown>) {
    super(message)
    this.name = new.target.name
    this.originalError = originalError
    this.context = context
    Object.setPrototypeOf(this, new.target.prototype)
  }

  /** Message plus the underlying git/fs detail, for one-line operator troubleshooting. */
  describe(): string {
    const parts = [this.message]
    if (this.originalError?.message)
      parts.push(`原始错误: ${this.originalError.message}`)
    if (this.context && Object.keys(this.context).length > 0)
      parts.push(JSON.stringify(this.context))
    return parts.join('\n')
  }

  report(): void {
    const text = this.describe()
    if (this.severity === 'warning')
      logger.warn(text)
    else if (this.severity === 'info')
      logger.info(text)
    else logger.error(text, this.originalError)
  }
}

export class ConfigError extends SyncError {
  readonly code = ErrorCode.CONFIG
}

export class ValidationError extends SyncError {
  readonly code = ErrorCode.VALIDATION
}

export class GitError extends SyncError {
  readonly code = ErrorCode.GIT
}

export class RepoPathError extends SyncError {
  readonly code = ErrorCode.REPO_PATH
}

export class FsError extends SyncError {
  readonly code = ErrorCode.FS
}

export class NetworkError extends SyncError {
  readonly code = ErrorCode.NETWORK
  override readonly severity: ErrorSeverity = 'warning'
}

export class ConflictError extends SyncError {
  readonly code = ErrorCode.CONFLICT
}

export class AuthenticationError extends SyncError {
  readonly code = ErrorCode.AUTHENTICATION
  override readonly severity: ErrorSeverity = 'critical'
}

export class PermissionError extends SyncError {
  readonly code = ErrorCode.PERMISSION
}

export class TimeoutError extends SyncError {
  readonly code = ErrorCode.TIMEOUT
  override readonly severity: ErrorSeverity = 'warning'
}

export class SyncProcessError extends SyncError {
  readonly code = ErrorCode.SYNC_PROCESS
}

export class UserCancelError extends SyncError {
  readonly code = ErrorCode.USER_CANCEL
  override readonly severity: ErrorSeverity = 'info'

  constructor(message = '用户取消了操作', context?: Record<string, unknown>) {
    super(message, undefined, context)
  }
}

export function isSyncError(error: unknown): error is SyncError {
  return error instanceof SyncError
}

export function toError(value: unknown): Error {
  if (value instanceof Error)
    return value
  return new Error(String(value))
}

/** Exit code per failure class: 1 unexpected, 2 config/validation, 3 git, 4 user cancelled. */
export function exitCodeFor(error: unknown): number {
  if (error instanceof UserCancelError)
    return 4
  if (error instanceof ConfigError || error instanceof ValidationError)
    return 2
  if (error instanceof GitError)
    return 3
  return 1
}

export function formatUnknownError(error: unknown): string {
  return red(`未预期的错误: ${yellow(toError(error).message)}`)
}
