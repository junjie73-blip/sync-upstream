import type { SyncPlan } from './change'

export enum GrayReleaseStrategy {
  PERCENTAGE = 'percentage',
  DIRECTORY = 'directory',
  FILE = 'file',
}

export enum GrayReleaseStage {
  IDLE = 'idle',
  CANARY = 'canary',
  VALIDATING = 'validating',
  COMPLETED = 'completed',
  FAILED = 'failed',
  ROLLED_BACK = 'rolled-back',
}

export interface GrayReleaseAlertThresholds {
  errorRate?: number
  performanceDrop?: number
  maxExecutionTime?: number
}

export interface GrayReleaseConfig {
  enable: boolean
  strategy: GrayReleaseStrategy
  percentage?: number
  canaryDirs?: string[]
  filePatterns?: string[]
  validationScript?: string
  maxRetries?: number
  rollbackOnFailure?: boolean
  auditLogPath?: string
  enableMonitoring?: boolean
  monitorInterval?: number
  alertThresholds?: GrayReleaseAlertThresholds
}

export interface GrayReleaseStatus {
  releaseId: string
  stage: GrayReleaseStage
  progress: number
  filesReleased: number
  totalFiles: number
  errors: string[]
  startedAt: number | null
  endedAt: number | null
}

/** A gray release runs the same plan twice: a subset first, the remainder on full release. */
export interface GrayReleaseSelection {
  releaseId: string
  canary: SyncPlan
  pending: SyncPlan
}
