import type {
  ChangeEntry,
  ConflictCandidate,
  GrayReleaseConfig,
  GrayReleaseSelection,
  RepoPath,
  SkippedEntry,
  SyncPlan,
} from '../domain'
import crypto from 'node:crypto'
import { GrayReleaseStage, GrayReleaseStrategy } from '../domain'
import { ValidationError } from '../errors'
import { t } from '../i18n'
import { newReleaseId } from './state'

/** Deterministic bucket in [0, 100) for a path, so re-running a plan picks the same canary set. */
export function bucketOf(repoPath: RepoPath): number {
  const hex = crypto.createHash('md5').update(repoPath).digest('hex').slice(0, 8)
  return Number.parseInt(hex, 16) % 100
}

function matchDirectory(scope: RepoPath, canaryDirs: RepoPath[]): boolean {
  return canaryDirs.some(dir => scope === dir || scope.startsWith(`${dir}/`))
}

function matchFile(repoPath: RepoPath, patterns: RepoPath[]): boolean {
  const name = repoPath.slice(repoPath.lastIndexOf('/') + 1)
  return patterns.some((pattern) => {
    if (pattern.includes('/'))
      return repoPath.endsWith(pattern.replace(/^\/+/, ''))
    if (pattern.startsWith('*.'))
      return name.endsWith(pattern.slice(1))
    return name === pattern
  })
}

/**
 * Split a plan into the canary subset and what is left for the full release.
 * The old implementation read `options.grayRelease` (a key that never existed), so every
 * run selected 0 files and the stage machine looped forever waiting for progress.
 */
export function selectCanary(plan: SyncPlan, config: GrayReleaseConfig): GrayReleaseSelection {
  if (!Number.isFinite(config.percentage) && config.strategy === GrayReleaseStrategy.PERCENTAGE) {
    throw new ValidationError(t('e.grayPctMissing'))
  }
  if (config.strategy === GrayReleaseStrategy.PERCENTAGE) {
    const percentage = config.percentage as number
    if (percentage <= 0 || percentage > 100) {
      throw new ValidationError(t('e.grayPctRange', { value: JSON.stringify(percentage) }))
    }
  }
  if (config.strategy === GrayReleaseStrategy.DIRECTORY && (config.canaryDirs ?? []).length === 0) {
    throw new ValidationError(t('e.grayNeedsCanaryDirs'))
  }
  if (config.strategy === GrayReleaseStrategy.FILE && (config.filePatterns ?? []).length === 0) {
    throw new ValidationError(t('e.grayNeedsFilePatterns'))
  }

  const canary: ChangeEntry[] = []
  const pending: ChangeEntry[] = []
  for (const entry of plan.changes) {
    (isCanary(entry, config) ? canary : pending).push(entry)
  }

  if (canary.length === 0) {
    throw new ValidationError(t('e.grayEmptySelection'))
  }

  const canaryPaths = new Set(canary.map(entry => entry.path))
  const releaseId = newReleaseId()
  return {
    releaseId,
    canary: subsetPlan(plan, canary, canaryPaths),
    pending: subsetPlan(plan, pending, new Set(pending.map(entry => entry.path))),
  }
}

function isCanary(entry: ChangeEntry, config: GrayReleaseConfig): boolean {
  switch (config.strategy) {
    case GrayReleaseStrategy.DIRECTORY:
      return matchDirectory(entry.scope, (config.canaryDirs ?? []).map(dir => dir.replace(/\\/g, '/').replace(/\/+$/, '')))
    case GrayReleaseStrategy.FILE:
      return matchFile(entry.path, config.filePatterns ?? [])
    case GrayReleaseStrategy.PERCENTAGE:
    default:
      return bucketOf(entry.path) < (config.percentage as number)
  }
}

function subsetPlan(plan: SyncPlan, changes: ChangeEntry[], paths: Set<RepoPath>): SyncPlan {
  const conflicts: ConflictCandidate[] = plan.conflicts.filter(conflict => paths.has(conflict.path))
  const skipped: SkippedEntry[] = plan.skipped.filter(item => paths.has(item.path))
  return {
    upstreamRef: plan.upstreamRef,
    targetBranch: plan.targetBranch,
    changes,
    conflicts,
    skipped,
    dirty: plan.dirty.filter(repoPath => paths.has(repoPath)),
  }
}

/** Progress of a stage machine; a completed stage never re-enters the loop. */
export function stageProgress(stage: GrayReleaseStage, released: number, total: number): number {
  if (stage === GrayReleaseStage.COMPLETED)
    return 100
  if (total <= 0)
    return 100
  return Math.min(100, Number.parseFloat(((released / total) * 100).toFixed(2)))
}
