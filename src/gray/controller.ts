import type {
  CommitResult,
  GrayReleaseConfig,
  GrayReleaseSelection,
  GrayReleaseStatus,
  RepoPath,
  SyncConfig,
  SyncPlan,
} from '../domain'
import type { GitRepository } from '../git/repository'
import path from 'node:path'
import { GrayReleaseStage } from '../domain'
import { logger } from '../logger'
import { GrayAudit } from './audit'
import { GrayMonitor } from './monitor'
import { rollbackRelease } from './rollback'
import { selectCanary, stageProgress } from './selection'
import { GrayState } from './state'
import { validateRelease } from './validate'

export interface GrayControllerDeps {
  git: GitRepository
  repoRoot: string
  config: SyncConfig
}

/**
 * Owns the gray-release stage machine: pick a canary subset, record it, validate the
 * result, then either roll back or leave the remainder for the full release.
 */
export class GrayController {
  private readonly grayConfig: GrayReleaseConfig
  private readonly state: GrayState
  private readonly audit: GrayAudit
  private readonly startedAt = Date.now()
  private monitor: GrayMonitor | null = null
  private selection: GrayReleaseSelection | null = null
  private released = 0
  private failed = 0

  private constructor(
    private readonly deps: GrayControllerDeps,
    state: GrayState,
  ) {
    this.grayConfig = deps.config.grayReleaseConfig as GrayReleaseConfig
    this.state = state
    this.audit = new GrayAudit(
      path.join(deps.repoRoot, this.grayConfig.auditLogPath ?? '.sync-gray-audit.jsonl'),
    )
  }

  static async create(deps: GrayControllerDeps): Promise<GrayController> {
    const config = deps.config.grayReleaseConfig
    if (!config?.enable)
      throw new Error('grayReleaseConfig.enable 为 false，无需创建 GrayController')
    const state = await GrayState.open(
      GrayState.pathFor(deps.repoRoot),
      deps.config,
      config.strategy,
    )
    return new GrayController(deps, state)
  }

  get releaseId(): string {
    return this.selection?.releaseId ?? this.state.releaseId
  }

  get pendingPaths(): RepoPath[] {
    return this.state.pendingPaths
  }

  /**
   * `fullRelease` publishes what the canary stage left over; otherwise the plan is narrowed
   * to the canary subset. A completed/empty stage never re-selects, which is what used to
   * spin the old loop at 0%.
   */
  restrict(plan: SyncPlan, fullRelease: boolean): SyncPlan {
    if (fullRelease) {
      if (this.state.pendingPaths.length === 0) {
        logger.info('没有待全量发布的灰度文件，直接执行完整同步')
        return plan
      }
      const pending = new Set(this.state.pendingPaths)
      return { ...plan, changes: plan.changes.filter(entry => pending.has(entry.path)) }
    }
    this.selection = selectCanary(plan, this.grayConfig)
    return this.selection.canary
  }

  async begin(plan: SyncPlan, baseCommit: string): Promise<void> {
    this.state.begin({
      canary: plan.changes.map(entry => entry.path),
      pending: this.selection?.pending.changes.map(entry => entry.path) ?? [],
      baseCommit,
    })
    await this.state.save()
    await this.audit.append({
      releaseId: this.state.releaseId,
      stage: GrayReleaseStage.CANARY,
      detail: `金丝雀阶段开始，共 ${plan.changes.length} 个文件，剩余 ${this.state.pendingPaths.length} 个待全量发布`,
    })

    if (this.grayConfig.enableMonitoring) {
      this.monitor = new GrayMonitor(this.grayConfig.alertThresholds, this.grayConfig.monitorInterval)
      this.monitor.start(() => ({
        elapsedMs: Date.now() - this.startedAt,
        released: this.released,
        failed: this.failed,
      }))
    }
  }

  /** Record the apply outcome so validation and monitoring see real numbers. */
  record(counts: { released: number, failed: number }): void {
    this.released = counts.released
    this.failed = counts.failed
  }

  async finish(commit: CommitResult | undefined, fullRelease: boolean): Promise<GrayReleaseStatus> {
    try {
      this.state.advance(GrayReleaseStage.VALIDATING, { commitHash: commit?.hash })

      if (this.grayConfig.validationScript) {
        const result = await validateRelease(this.grayConfig, this.deps.repoRoot)
        if (!result.ok) {
          const message = `灰度校验失败: ${result.error ?? '未知原因'}`
          this.state.fail(message)
          await this.audit.append({ releaseId: this.state.releaseId, stage: GrayReleaseStage.FAILED, detail: message })
          logger.error(message)

          if (this.grayConfig.rollbackOnFailure) {
            const outcome = await rollbackRelease(this.deps.git, this.state, `chore(sync): rollback gray release ${this.state.releaseId}`)
            this.state.advance(GrayReleaseStage.ROLLED_BACK)
            await this.audit.append({
              releaseId: this.state.releaseId,
              stage: GrayReleaseStage.ROLLED_BACK,
              detail: `恢复 ${outcome.restored.length} 个文件，移除 ${outcome.removed.length} 个${outcome.reason ? `（${outcome.reason}）` : ''}`,
            })
          }
          return this.status()
        }
        await this.audit.append({
          releaseId: this.state.releaseId,
          stage: GrayReleaseStage.VALIDATING,
          detail: `校验通过（${result.attempts} 次尝试，${result.durationMs}ms）`,
        })
      }

      this.state.advance(GrayReleaseStage.COMPLETED, { commitHash: commit?.hash })
      if (fullRelease)
        await this.state.clear()
      else await this.state.save()

      await this.audit.append({
        releaseId: this.state.releaseId,
        stage: GrayReleaseStage.COMPLETED,
        detail: fullRelease
          ? '全量发布完成'
          : `金丝雀发布完成，${this.state.pendingPaths.length} 个文件等待 --full-release`,
      })
      return this.status()
    }
    finally {
      this.monitor?.stop()
    }
  }

  /** Read-only view, usable without an active release (e.g. `--rollback` runs). */
  status(): GrayReleaseStatus {
    const total = this.state.canaryPaths.length + this.state.pendingPaths.length
    return {
      releaseId: this.state.releaseId,
      stage: this.state.stage,
      progress: stageProgress(this.state.stage, this.released, total),
      filesReleased: this.released,
      totalFiles: total,
      errors: this.state.errors,
      startedAt: this.startedAt,
      endedAt: this.state.stage === GrayReleaseStage.COMPLETED ? Date.now() : null,
    }
  }

  /** `--rollback` entry point: undo whatever the recorded release touched. */
  async rollback(): Promise<GrayReleaseStatus> {
    const outcome = await rollbackRelease(
      this.deps.git,
      this.state,
      `chore(sync): rollback gray release ${this.state.releaseId}`,
    )
    if (outcome.reason && !outcome.commitHash) {
      this.state.fail(outcome.reason)
      logger.warn(outcome.reason)
    }
    else {
      this.state.advance(GrayReleaseStage.ROLLED_BACK, { commitHash: outcome.commitHash })
    }
    await this.state.save()
    await this.audit.append({
      releaseId: this.state.releaseId,
      stage: this.state.stage,
      detail: `回滚：恢复 ${outcome.restored.length} 个，移除 ${outcome.removed.length} 个，提交 ${outcome.commitHash ?? '无'}`,
    })
    return this.status()
  }
}
