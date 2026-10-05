import type {
  AppliedChange,
  ApplyResult,
  CommitResult,
  ConflictDecision,
  ConflictPrompt,
  GrayReleaseStatus,
  SyncConfig,
  SyncPlan,
} from '../domain'
import path from 'node:path'
import process from 'node:process'
import { ConflictResolver, formatConflictReport } from '../conflict'
import { ChangeKind, ConflictResolutionStrategy } from '../domain'
import { GitError, toError } from '../errors'
import { loadIgnoreMatcher } from '../fsx/ignore-source'
import { sshCommand } from '../git/auth'
import { GitRepository } from '../git/repository'
import { redacted, toClonableUrl } from '../git/url'
import { GrayController } from '../gray'
import { logger } from '../logger'
import { withRetry } from '../retry'
import { applyChanges, failedChanges } from './apply'
import { commitChanges, pushChanges } from './commit'
import { createConflictContentSource } from './conflict-source'
import { buildPlan } from './plan'
import { formatApplyResult, formatCommitResult, formatGrayStatus, formatPlan } from './preview'
import { SYNC_STATE_FILE, SyncState } from './sync-state'

/** Dedicated remote so the tool never rewrites the user's `origin`. */
export const UPSTREAM_REMOTE = 'sync-upstream'

export interface OrchestratorOptions {
  config: SyncConfig
  cwd?: string
  /** Only consulted when the default strategy is PROMPT_USER. */
  prompt?: ConflictPrompt
}

export interface SyncRunResult {
  plan: SyncPlan
  decisions: ConflictDecision[]
  applied?: ApplyResult
  commit?: CommitResult
  gray?: GrayReleaseStatus
  /** True when the run stopped before touching the working tree. */
  previewed: boolean
}

const RETRYABLE = /网络|network|connect|resolve host|timed out|timeout|RPC failed|early EOF|The remote end/i

export class SyncOrchestrator {
  private readonly config: SyncConfig
  private readonly cwd: string
  private readonly prompt?: ConflictPrompt
  private git!: GitRepository
  private repoRoot!: string

  constructor(options: OrchestratorOptions) {
    this.config = options.config
    this.cwd = options.cwd ?? process.cwd()
    this.prompt = options.prompt
  }

  async run(): Promise<SyncRunResult> {
    const preview = this.config.previewOnly || this.config.dryRun
    const { plan, upstreamRef } = await this.prepare(preview)
    const gray = await this.createGrayController()
    const workingPlan = gray ? gray.restrict(plan, this.config.fullRelease) : plan

    for (const line of formatPlan(workingPlan, this.config.verbose ? Number.POSITIVE_INFINITY : 40))
      logger.info(line)

    if (this.config.rollback) {
      if (!gray)
        throw new GitError('--rollback 需要同时启用 grayReleaseConfig')
      const status = await gray.rollback()
      for (const line of formatGrayStatus(status)) logger.info(line)
      return { plan: workingPlan, decisions: [], previewed: false, gray: status }
    }

    if (preview) {
      logger.warn(this.config.dryRun ? 'dryRun 模式：不会修改工作区' : '预览模式：不会修改工作区')
      return { plan: workingPlan, decisions: [], previewed: true }
    }

    const decisions = await this.resolveConflicts(workingPlan, upstreamRef)
    // The stage machine needs the pre-sync commit so a later --rollback can restore it.
    await gray?.begin(workingPlan, await this.git.head())
    const applied = await applyChanges({
      git: this.git,
      upstreamRef,
      repoRoot: this.repoRoot,
      plan: workingPlan,
      decisions: new Map(decisions.map(decision => [decision.path, decision])),
      concurrencyLimit: this.config.concurrencyLimit,
    })

    for (const line of formatApplyResult(applied)) logger.info(line)
    const commit = await commitChanges({
      git: this.git,
      plan: workingPlan,
      result: applied,
      message: this.config.commitMessage,
    })
    for (const line of formatCommitResult(commit)) logger.info(line)

    await this.persistState(applied.applied, workingPlan)
    gray?.record({
      released: applied.applied.filter(item => item.status === 'applied').length,
      failed: failedChanges(applied).length,
    })

    const grayStatus = gray
      ? await gray.finish(commit, this.config.fullRelease)
      : undefined
    if (grayStatus) {
      for (const line of formatGrayStatus(grayStatus)) logger.info(line)
    }

    if (this.config.autoPush && commit.created)
      await this.publish()

    return { plan: workingPlan, decisions, applied, commit, gray: grayStatus, previewed: false }
  }

  /** Fetch upstream, land on the target branch, and compute the plan. */
  private async prepare(preview: boolean): Promise<{ plan: SyncPlan, upstreamRef: string }> {
    this.git = new GitRepository(this.cwd, { env: sshCommand(this.config.authConfig) })
    await this.git.assertWorkTree()
    this.repoRoot = await this.git.repoRoot()

    const url = toClonableUrl(this.config.upstreamRepo, this.config.authConfig)
    await this.git.ensureRemote(UPSTREAM_REMOTE, url)
    logger.info(`拉取上游 ${redacted(url)} (${this.config.upstreamBranch})…`)

    await withRetry(
      () => this.git.fetch(UPSTREAM_REMOTE, this.config.upstreamBranch),
      { ...this.config.retryConfig, isRetryable: error => RETRYABLE.test(error.message) },
    )

    const upstreamRef = await this.resolveUpstreamRef()
    if (preview) {
      // 计划读的是目标分支的对象库，只读运行没必要移动 HEAD
      await this.assertTargetBranchExists()
    }
    else {
      await this.ensureTargetBranch()
      if (this.config.branchStrategyConfig?.enable)
        await this.applyBranchStrategy()
    }

    const { matcher } = await loadIgnoreMatcher({
      repoRoot: this.repoRoot,
      scopes: this.config.syncDirs,
      configPatterns: this.config.ignorePatterns,
    })

    const state = await SyncState.load(
      path.join(this.repoRoot, SYNC_STATE_FILE),
      this.config.upstreamRepo,
      this.config.upstreamBranch,
    )

    const plan = await buildPlan({
      git: this.git,
      config: this.config,
      upstreamRef,
      ignore: matcher,
      state: this.config.forceOverwrite ? undefined : state,
    })
    return { plan, upstreamRef }
  }

  private async resolveUpstreamRef(): Promise<string> {
    const candidates = [
      `refs/remotes/${UPSTREAM_REMOTE}/${this.config.upstreamBranch}`,
      `${UPSTREAM_REMOTE}/${this.config.upstreamBranch}`,
      'FETCH_HEAD',
    ]
    for (const candidate of candidates) {
      if (await this.git.refExists(candidate))
        return candidate
    }
    throw new GitError(
      `上游分支 ${this.config.upstreamBranch} 在 ${redacted(this.config.upstreamRepo)} 中不存在`,
    )
  }

  private async assertTargetBranchExists(): Promise<void> {
    const target = this.config.companyBranch
    if (await this.git.branchExists(target))
      return
    if (await this.git.refExists(`refs/remotes/origin/${target}`))
      return
    throw new GitError(`目标分支 ${target} 既不在本地也不在 origin，请先创建后重试`)
  }

  private async ensureTargetBranch(): Promise<void> {
    const target = this.config.companyBranch
    const current = await this.git.currentBranch()
    if (current === target)
      return

    if (!(await this.git.branchExists(target))) {
      await this.assertTargetBranchExists()
      await this.git.exec(['branch', '--track', target, `origin/${target}`])
    }
    logger.info(`切换到目标分支 ${target}（原分支 ${current}）`)
    await this.git.checkout(target)
  }

  /** Work on a generated branch instead of the plain target branch. */
  private async applyBranchStrategy(): Promise<void> {
    const strategy = this.config.branchStrategyConfig
    if (!strategy)
      return
    const branch = resolveBranchName(strategy.branchPattern, {
      base: strategy.baseBranch,
      strategy: strategy.strategy,
    })
    if (await this.git.branchExists(branch)) {
      await this.git.checkout(branch)
    }
    else {
      if (!(await this.git.refExists(strategy.baseBranch))) {
        throw new GitError(`分支策略的基准分支 ${strategy.baseBranch} 不存在`)
      }
      await this.git.createBranch(branch, strategy.baseBranch)
    }
    logger.success(`分支策略：在 ${branch} 上执行同步（策略 ${strategy.strategy}）`)
  }

  private async createGrayController(): Promise<GrayController | null> {
    if (!this.config.grayReleaseConfig?.enable)
      return null
    return GrayController.create({ git: this.git, repoRoot: this.repoRoot, config: this.config })
  }

  private async resolveConflicts(plan: SyncPlan, upstreamRef: string): Promise<ConflictDecision[]> {
    if (plan.conflicts.length === 0)
      return []

    const config = { ...this.config.conflictResolutionConfig }
    if (this.config.nonInteractive && config.defaultStrategy === ConflictResolutionStrategy.PROMPT_USER) {
      config.defaultStrategy = ConflictResolutionStrategy.KEEP_TARGET
      logger.warn(`非交互式模式：${plan.conflicts.length} 个冲突文件按保留本地处理（用 conflictResolutionConfig.defaultStrategy 改变该行为）`)
    }

    const resolver = new ConflictResolver(config, {
      prompt: config.defaultStrategy === ConflictResolutionStrategy.PROMPT_USER ? this.prompt : undefined,
      onResolved: record => logger.debug(`冲突已解决: ${record.path} → ${record.action}`),
    })
    const base = await this.git.mergeBase(this.config.companyBranch, upstreamRef)
    const decisions = await resolver.resolve(
      plan.conflicts,
      createConflictContentSource({ git: this.git, repoRoot: this.repoRoot, upstreamRef, baseRef: base }),
    )
    for (const line of formatConflictReport(decisions)) logger.info(line)
    return decisions
  }

  private async persistState(applied: AppliedChange[], plan: SyncPlan): Promise<void> {
    try {
      const state = await SyncState.load(
        path.join(this.repoRoot, SYNC_STATE_FILE),
        this.config.upstreamRepo,
        this.config.upstreamBranch,
      )
      state.record(applied)
      // Skipped deletions must not look "already synced" next run.
      state.forget(plan.changes.filter(entry => entry.kind === ChangeKind.DELETE).map(entry => entry.path))
      await state.save()
    }
    catch (error) {
      logger.warn(`同步状态写入失败（不影响本次结果）: ${toError(error).message}`)
    }
  }

  private async publish(): Promise<void> {
    const target = await this.git.pushTarget(this.config.companyBranch)
    try {
      await pushChanges({ git: this.git, remote: target.remote, branch: target.branch })
      logger.success(`已推送到 ${target.remote}/${target.branch}`)
    }
    catch (error) {
      throw new GitError(`推送到 ${target.remote}/${target.branch} 失败`, toError(error))
    }
  }
}

export function resolveBranchName(pattern: string, vars: { base: string, strategy: string }): string {
  const date = new Date().toISOString().slice(0, 10)
  return pattern
    .replace(/\{date\}/g, date)
    .replace(/\{base\}/g, vars.base)
    .replace(/\{strategy\}/g, vars.strategy)
    .replace(/[\\/]/g, '/')
    .trim()
}
