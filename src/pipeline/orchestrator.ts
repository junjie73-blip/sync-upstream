import type {
  AppliedChange,
  ApplyResult,
  CommitResult,
  ConflictDecision,
  ConflictPrompt,
  ConflictRecord,
  GrayReleaseStatus,
  LfsFacts,
  PrConfig,
  SyncConfig,
  SyncPlan,
} from '../domain'
import type { PullRequestFacts } from './pr'
import type { LockHandle } from './repo-lock'
import type { SyncSource } from './sources'
import type { UndoResult } from './undo'
import path from 'node:path'
import process from 'node:process'
import fs from 'fs-extra'
import { ConflictResolver, formatConflictReport } from '../conflict'
import { ChangeKind, ConflictResolutionStrategy, planSummary } from '../domain'
import { GitError, toError, ValidationError } from '../errors'
import { loadIgnoreMatcher } from '../fsx/ignore-source'
import { sshCommand } from '../git/auth'
import { detectLfsPointers, materializeLfsPointers, scanWorkingTreePointers } from '../git/lfs'
import { GitRepository } from '../git/repository'
import { redacted, toClonableUrl } from '../git/url'
import { GrayController } from '../gray'
import { joinList, t } from '../i18n'
import { logger } from '../logger'
import { applyChanges, failedChanges } from './apply'
import { commitChanges, pushChanges } from './commit'
import { createConflictContentSource } from './conflict-source'
import { buildPlan, plannedDeletes, protectPlanDeletes } from './plan'
import { compareUrl, prBranchName, uniqueBranchName } from './pr'
import { createPullRequest, findPrTool, toolForRemote } from './pr-cli'
import { formatApplyResult, formatCommitResult, formatGrayStatus, formatLfsFacts, formatPlan, formatPrResult, formatUndoResult } from './preview'
import { withRepoLock } from './repo-lock'
import { sourcesOf } from './sources'
import { SyncState } from './sync-state'
import { undoLastSync } from './undo'
import { describeSource, fetchSource, requireSourceRef, resolvedKind, UPSTREAM_REMOTE } from './upstream-ref'

/** Re-exported for existing importers; the constant itself lives beside the ref resolution. */
export { UPSTREAM_REMOTE }

export interface OrchestratorOptions {
  config: SyncConfig
  cwd?: string
  /** Only consulted when the default strategy is PROMPT_USER. */
  prompt?: ConflictPrompt
  /**
   * Only consulted when `deletePolicy: 'ask'`. Answer `true` to let the upstream deletions
   * through, `false` to keep every local file.
   */
  confirmDeletes?: (count: number) => Promise<boolean>
}

/** What one source contributed to a run. */
export interface SourceRunResult {
  /** `repo-name@ref`, as configured. */
  label: string
  repo: string
  ref: string
  kind: 'branch' | 'tag' | 'revision'
  remote: string
  /** State file this source reads and writes, relative to the repository root. */
  stateFile: string
  plan: SyncPlan
  decisions: ConflictDecision[]
  applied?: ApplyResult
  commit?: CommitResult
  /** Resolved local ref the files were taken from, e.g. `refs/remotes/sync-upstream/main`. */
  upstreamRef: string
  previewed: boolean
  lfs?: LfsFacts
}

export interface SyncRunResult {
  plan: SyncPlan
  decisions: ConflictDecision[]
  applied?: ApplyResult
  commit?: CommitResult
  gray?: GrayReleaseStatus
  /**
   * Set when `prConfig` ran the sync as a pull request: the commits are on `branch`, the target
   * branch is untouched, and this says what happened to the branch afterwards.
   */
  pullRequest?: PullRequestFacts
  /** Git LFS findings, merged over every source; undefined when nothing pointed at LFS. */
  lfs?: LfsFacts
  /** True when the run stopped before touching the working tree. */
  previewed: boolean
  /** Branch HEAD was on when the run started. */
  startedOn?: string
  /** Branch HEAD is on when the run finished (or failed). */
  endedOn?: string
  /**
   * Per-source results. Length 1 for an ordinary run; the top-level fields above are the
   * aggregate of these, so existing callers keep working unchanged.
   */
  sources: SourceRunResult[]
}

/**
 * Say the LFS thing out loud.
 *
 * Materialising content that arrived is news, so it goes at info; everything else is a warning,
 * because "the file you expected to be a PNG is 130 bytes of text" is never what anybody meant.
 */
function logLfs(facts?: LfsFacts): void {
  if (!facts)
    return
  const level = facts.materialized.length > 0 && !facts.note ? 'info' : 'warn'
  for (const line of formatLfsFacts(facts))
    logger[level](line)
}

/**
 * One LFS answer for the whole run.
 *
 * Every fan-in source reports its own pointers; callers read `result.lfs`, so the lists are
 * concatenated and the first note is kept — two sources failing for two reasons is rare enough
 * that a second line in the log is all the detail anyone gets anyway.
 */
function mergeLfsFacts(results: SourceRunResult[]): LfsFacts | undefined {
  const found = results.map(item => item.lfs).filter((item): item is LfsFacts => item !== undefined)
  if (found.length === 0)
    return undefined
  return {
    mode: found[0].mode,
    pointers: found.flatMap(item => item.pointers),
    materialized: found.flatMap(item => item.materialized),
    ...(found.find(item => item.note)?.note ? { note: found.find(item => item.note)?.note } : {}),
  }
}

export class SyncOrchestrator {
  private readonly config: SyncConfig
  private readonly cwd: string
  private readonly prompt?: ConflictPrompt
  private git!: GitRepository
  private repoRoot!: string
  /** Branch a PR-mode run created; undefined for every other mode. */
  private prBranch?: string
  private readonly confirmDeletes?: (count: number) => Promise<boolean>

  constructor(options: OrchestratorOptions) {
    this.config = options.config
    this.cwd = options.cwd ?? process.cwd()
    this.prompt = options.prompt
    this.confirmDeletes = options.confirmDeletes
  }

  /**
   * Everything that can mutate the repository — fetch, branch switches, apply, commit,
   * push — happens under the repository lock. Two runs in one working tree otherwise
   * interleave their index writes and produce commits neither of them planned.
   */
  async run(): Promise<SyncRunResult> {
    this.git = new GitRepository(this.cwd, { env: sshCommand(this.config.authConfig, this.cwd) })
    await this.git.assertWorkTree()
    this.repoRoot = await this.git.repoRoot()
    const gitDir = await this.git.gitDirectory()
    const startedOn = await this.git.currentBranch().catch(() => 'HEAD')

    return withRepoLock(
      {
        gitDir,
        label: `sync ${this.config.upstreamBranch} → ${this.config.companyBranch}`,
        waitMs: this.config.lockWaitMs ?? 0,
      },
      async (handle) => {
        try {
          const result = await this.runLocked(startedOn, handle)
          return { ...result, startedOn, endedOn: await this.git.currentBranch().catch(() => 'HEAD') }
        }
        catch (error) {
          // Never leave a moved HEAD unexplained: the next `git status` would look like
          // the user switched branches themselves.
          const where = await this.git.currentBranch().catch(() => '未知')
          logger.error(`同步中断，HEAD 目前位于 ${where}（运行前为 ${startedOn}）`)
          throw error
        }
      },
    )
  }

  /**
   * `--undo`: step back over the most recent recorded sync. Same lock as a run, because it
   * moves HEAD and rewrites the state file.
   */
  async undo(): Promise<UndoResult> {
    this.git = new GitRepository(this.cwd, { env: sshCommand(this.config.authConfig, this.cwd) })
    await this.git.assertWorkTree()
    this.repoRoot = await this.git.repoRoot()
    const gitDir = await this.git.gitDirectory()

    return withRepoLock(
      { gitDir, label: `undo → ${this.config.companyBranch}`, waitMs: this.config.lockWaitMs ?? 0 },
      async (handle) => {
        const result = await undoLastSync({ git: this.git, config: this.config, repoRoot: this.repoRoot })
        if (!result.reverted)
          return result

        for (const line of formatUndoResult(result)) logger.info(line)
        if (this.config.autoPush && result.branch) {
          await handle.ensureHeld()
          const target = await this.git.pushTarget(result.branch)
          await pushChanges({ git: this.git, remote: target.remote, branch: target.branch })
          logger.success(`已推送撤销提交到 ${target.remote}/${target.branch}`)
        }
        return result
      },
    )
  }

  private async runLocked(startedOn: string, handle: LockHandle): Promise<SyncRunResult> {
    const preview = this.config.previewOnly || this.config.dryRun
    const sources = sourcesOf(this.config)
    this.assertSingleSourceOnly(sources)

    // Landing on the target branch belongs to the run, not to a source: doing it per source
    // would check the same branch out N times and hide which step moved HEAD. It has to happen
    // before any plan is built, because dirty/untracked detection reads the working tree.
    if (preview) {
      // 计划读的是目标分支的对象库，只读运行没必要移动 HEAD
      await this.assertTargetBranchExists()
    }
    else {
      await this.ensureTargetBranch()
      if (this.config.prConfig?.enable)
        this.prBranch = await this.enterPrBranch()
      else if (this.config.branchStrategyConfig?.enable)
        await this.applyBranchStrategy()
    }

    const gray = await this.createGrayController()

    if (this.config.rollback) {
      if (!gray)
        throw new GitError(t('e.rollbackNeedsGray'))
      const prepared = await this.prepareSource(sources[0])
      for (const line of formatPlan(prepared.plan, this.config.verbose ? Number.POSITIVE_INFINITY : 40))
        logger.info(line)
      const status = await gray.rollback()
      for (const line of formatGrayStatus(status)) logger.info(line)
      return {
        plan: prepared.plan,
        decisions: [],
        previewed: false,
        gray: status,
        startedOn,
        sources: [this.sourceResult(sources[0], prepared.plan, prepared.upstreamRef, { previewed: false })],
      }
    }

    const results: SourceRunResult[] = []
    for (const [position, source] of sources.entries()) {
      if (sources.length > 1)
        logger.info(`── 源 ${position + 1}/${sources.length}: ${source.label}`)
      results.push(await this.runSource(source, preview, gray, handle))
    }

    let grayStatus: GrayReleaseStatus | undefined
    // Same as before the fan-in refactor: the stage machine is finished whenever a real (not
    // preview) run reached a commit result, even when that commit turned out to be empty.
    const only = results[0]
    if (gray && !preview && only?.commit) {
      grayStatus = await gray.finish(only.commit, this.config.fullRelease)
      for (const line of formatGrayStatus(grayStatus)) logger.info(line)
    }

    await this.deleteMergedBranchesIfEnabled()

    let pullRequest: PullRequestFacts | undefined
    if (this.prBranch) {
      pullRequest = results.some(item => item.commit?.created)
        ? await this.publishPullRequest(results)
        : await this.discardEmptyPrBranch()
    }

    const merged = this.mergeResults(results, preview, startedOn)
    if (preview) {
      logger.warn(this.config.dryRun ? 'dryRun 模式：不会修改工作区' : '预览模式：不会修改工作区')
      return { ...merged, gray: grayStatus }
    }

    if (this.config.autoPush && merged.commit?.created) {
      await handle.ensureHeld()
      await this.publish()
    }
    await this.switchBackIfNeeded(startedOn)

    return { ...merged, gray: grayStatus, ...(pullRequest ? { pullRequest } : {}) }
  }

  /**
   * Gray release and `--rollback` keep their own single stage record per repository; fan-in
   * would need one per source. Refusing the combination beats quietly letting the second
   * source overwrite the first one's gray state.
   */
  private assertSingleSourceOnly(sources: SyncSource[]): void {
    if (sources.length < 2)
      return
    const blocked: string[] = []
    if (this.config.grayReleaseConfig?.enable)
      blocked.push(t('e.blockedGray'))
    if (this.config.rollback)
      blocked.push(t('e.blockedRollback'))
    if (this.config.fullRelease)
      blocked.push(t('e.blockedFullRelease'))
    if (blocked.length > 0) {
      throw new ValidationError(
        t('e.multiUpstreamBlocked', { list: joinList(blocked) }),
      )
    }
  }

  /** Fetch → plan → conflicts → apply → commit → state, for exactly one source. */
  private async runSource(
    source: SyncSource,
    preview: boolean,
    gray: GrayController | null,
    handle: LockHandle,
  ): Promise<SourceRunResult> {
    const prepared = await this.prepareSource(source)
    const answered = await this.askAboutDeletes(prepared.plan, preview)
    const workingPlan = gray ? gray.restrict(answered, this.config.fullRelease) : answered

    for (const line of formatPlan(workingPlan, this.config.verbose ? Number.POSITIVE_INFINITY : 40))
      logger.info(line)

    if (preview) {
      const lfs = await this.reportLfs(source, workingPlan, prepared.upstreamRef)
      logLfs(lfs)
      return this.sourceResult(source, workingPlan, prepared.upstreamRef, { previewed: true, lfs })
    }

    const decisions = await this.resolveConflicts(workingPlan, prepared.upstreamRef)
    // Last chance to bail out before the working tree is rewritten: a lock stolen during the
    // (slow) fetch means another run is already moving HEAD and the index.
    await handle.ensureHeld()
    // The stage machine needs the pre-sync commit so a later --rollback can restore it.
    const baseCommit = await this.git.head()
    await gray?.begin(workingPlan, baseCommit)
    const applied = await applyChanges({
      git: this.git,
      upstreamRef: prepared.upstreamRef,
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
      message: source.commitMessage,
    })
    for (const line of formatCommitResult(commit)) logger.info(line)

    const lfs = await this.reportLfs(source, workingPlan, prepared.upstreamRef, applied)
    logLfs(lfs)

    await this.persistState(source, applied.applied, workingPlan, {
      commit,
      baseCommit,
      upstreamRef: prepared.upstreamRef,
    })
    gray?.record({
      released: applied.applied.filter(item => item.status === 'applied').length,
      failed: failedChanges(applied).length,
    })

    return this.sourceResult(source, workingPlan, prepared.upstreamRef, { previewed: false, decisions, applied, commit, lfs })
  }

  private sourceResult(
    source: SyncSource,
    plan: SyncPlan,
    upstreamRef: string,
    extra: { previewed: boolean, decisions?: ConflictDecision[], applied?: ApplyResult, commit?: CommitResult, lfs?: LfsFacts },
  ): SourceRunResult {
    return {
      label: source.label,
      repo: source.repo,
      ref: source.ref,
      kind: resolvedKind(source.source, upstreamRef),
      remote: source.remote,
      stateFile: source.stateFile,
      plan,
      upstreamRef,
      decisions: extra.decisions ?? [],
      ...(extra.applied ? { applied: extra.applied } : {}),
      ...(extra.commit ? { commit: extra.commit } : {}),
      ...(extra.lfs ? { lfs: extra.lfs } : {}),
      previewed: extra.previewed,
    }
  }

  /** Fold the per-source results into the single result every caller already reads. */
  private mergeResults(results: SourceRunResult[], preview: boolean, startedOn: string): SyncRunResult {
    const plan: SyncPlan = {
      upstreamRef: results[0]?.upstreamRef ?? '',
      targetBranch: this.config.companyBranch,
      changes: results.flatMap(item => item.plan.changes),
      conflicts: results.flatMap(item => item.plan.conflicts),
      skipped: results.flatMap(item => item.plan.skipped),
      dirty: [...new Set(results.flatMap(item => item.plan.dirty))],
    }
    const appliedList = results.flatMap(item => item.applied?.applied ?? [])
    const created = results.filter(item => item.commit?.created)
    const lastCommit = results.length > 0 ? results[results.length - 1].commit : undefined
    const lfs = mergeLfsFacts(results)

    return {
      plan,
      decisions: results.flatMap(item => item.decisions),
      ...(appliedList.length > 0 || results.some(item => item.applied)
        ? { applied: { applied: appliedList, stagedPaths: [...new Set(results.flatMap(item => item.applied?.stagedPaths ?? []))] } }
        : {}),
      ...(created.length > 0 ? { commit: created[created.length - 1].commit } : (lastCommit ? { commit: lastCommit } : {})),
      ...(lfs ? { lfs } : {}),
      previewed: preview,
      startedOn,
      sources: results,
    }
  }

  /**
   * Look at what this source put in the working tree (or would put there, in preview) and report
   * the files that are Git LFS pointers.
   *
   * Deliberately not fatal in any direction: a pointer is what git itself stores, so the sync is
   * complete and reviewable even when `git-lfs` is missing or the upstream's LFS server is down.
   * What would be lost is the binary content, which is exactly the thing an operator needs a line
   * about in the log rather than a mystery in the next build.
   */
  private async reportLfs(
    source: SyncSource,
    plan: SyncPlan,
    upstreamRef: string,
    applied?: ApplyResult,
  ): Promise<LfsFacts | undefined> {
    const mode = this.config.fetchConfig?.lfs ?? 'pointer'
    if (mode === 'off')
      return undefined

    const paths = (applied
      ? applied.applied.filter(item => item.status === 'applied').map(item => item.entry)
      : plan.changes.filter(entry => entry.kind !== ChangeKind.DELETE)
    ).filter(entry => entry.kind !== ChangeKind.DELETE).map(entry => entry.path)
    if (paths.length === 0)
      return undefined

    const scan = applied
      ? await scanWorkingTreePointers(this.repoRoot, paths)
      : await detectLfsPointers(paths, repoPath => this.git.readBlobTextSafe(upstreamRef, repoPath))

    const facts: LfsFacts = { mode, pointers: scan.pointers, materialized: [] }
    if (scan.pointers.length === 0)
      return undefined

    if (mode === 'materialize' && applied) {
      const outcome = await materializeLfsPointers({
        cwd: this.repoRoot,
        remote: source.remote,
        ref: upstreamRef,
        paths: scan.pointers,
      })
      facts.materialized = outcome.replaced
      // Either the objects arrived and every listed pointer became real content, or the note says
      // why none of them did; `git lfs fetch` is not asked to half-succeed.
      if (outcome.note)
        facts.note = outcome.note
    }
    return facts
  }

  /**
   * Fetch one source and compute its plan. Nothing here moves HEAD — the run already landed on
   * the target branch before the first source was fetched.
   */
  private async prepareSource(source: SyncSource): Promise<{ plan: SyncPlan, upstreamRef: string }> {
    const url = toClonableUrl(source.repo, this.config.authConfig)
    await this.git.ensureRemote(source.remote, url)
    logger.info(`拉取上游 ${redacted(url)} 的${describeSource(source.source)}…`)
    await fetchSource(this.git, source.remote, source.source, source.repo, this.config.retryConfig, this.config.fetchConfig)

    const upstreamRef = await requireSourceRef(this.git, source.remote, source.source, source.repo)

    const { matcher } = await loadIgnoreMatcher({
      repoRoot: this.repoRoot,
      scopes: source.dirs,
      configPatterns: this.config.ignorePatterns,
    })

    // A PR-mode run never lands anything on the target branch, so neither side of its
    // incremental state may be trusted: reading it would skip work the branch does not have,
    // writing it would claim the branch holds content that only exists on the PR branch.
    const state = this.prBranch || this.config.forceOverwrite
      ? undefined
      : await this.loadState(source)
    const symlinksSupported = await this.git.supportsSymlinks()

    const plan = await buildPlan({
      git: this.git,
      config: { ...this.config, syncDirs: source.dirs },
      upstreamRef,
      ignore: matcher,
      state,
      symlinksSupported,
    })
    return { plan, upstreamRef }
  }

  private async loadState(source: SyncSource): Promise<SyncState> {
    return SyncState.load(path.join(this.repoRoot, source.stateFile), {
      upstreamRepo: source.repo,
      upstreamBranch: source.ref,
      companyBranch: this.config.companyBranch,
    })
  }

  private async assertTargetBranchExists(): Promise<void> {
    const target = this.config.companyBranch
    if (await this.git.branchExists(target))
      return
    if (await this.git.refExists(`refs/remotes/origin/${target}`))
      return
    throw new GitError(t('e.targetBranchMissing', { branch: target }))
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
        throw new GitError(t('e.baseBranchMissing', { branch: strategy.baseBranch }))
      }
      await this.git.createBranch(branch, strategy.baseBranch)
    }
    logger.success(`分支策略：在 ${branch} 上执行同步（策略 ${strategy.strategy}）`)
  }

  /**
   * `deletePolicy: 'ask'` — show the deletions, then let the operator decide for this run.
   * Anything that cannot answer (`-y`, `--json`, no prompt wired) keeps the local files: a
   * skipped deletion is recoverable next run, a deleted file the reviewer did not approve is not.
   */
  private async askAboutDeletes(plan: SyncPlan, preview: boolean): Promise<SyncPlan> {
    if (this.config.deletePolicy !== 'ask' || preview)
      return plan
    const count = plannedDeletes(plan)
    if (count === 0)
      return plan

    if (this.config.nonInteractive || !this.confirmDeletes) {
      logger.warn(`deletePolicy 为 ask 但当前无法询问：保留这 ${count} 个上游已删除的文件（要跟随删除请用 --delete 或 deletePolicy: mirror）`)
      return protectPlanDeletes(plan, 'deletePolicy 为 ask，但本次无法询问，已保留本地文件')
    }

    if (await this.confirmDeletes(count)) {
      logger.info(`已确认删除上游移除的 ${count} 个文件`)
      return plan
    }
    logger.info(`按选择保留上游已删除的 ${count} 个文件`)
    return protectPlanDeletes(plan, 'deletePolicy 为 ask，本次询问选择保留')
  }

  /**
   * PR mode: work on a fresh branch cut from the target branch. The name gets a suffix when it
   * already exists, because pushing onto an open PR branch would silently widen that review.
   */
  private async enterPrBranch(): Promise<string> {
    const base = this.config.companyBranch
    const wanted = prBranchName(this.config.prConfig, base)
    const { branch, reusedSuffix } = await uniqueBranchName(this.git, wanted)
    if (reusedSuffix) {
      logger.warn(`分支 ${wanted} 已存在，本次改用 ${branch}（不往可能正在评审的分支上追加提交）`)
    }
    await this.git.createBranch(branch, base)
    logger.success(`PR 模式：改动提交到 ${branch}，目标分支 ${base} 保持不变`)
    return branch
  }

  /**
   * Nothing to sync means nothing to review: an empty branch would be pushed as a pull request,
   * and one that is only left locally makes the next run pick `-2`, then `-3`, forever.
   */
  private async discardEmptyPrBranch(): Promise<undefined> {
    const branch = this.prBranch as string
    this.prBranch = undefined
    await this.git.checkout(this.config.companyBranch).catch(() => undefined)
    await this.git.deleteBranch(branch, false).catch(() => undefined)
    logger.info('PR 模式：本次没有需要同步的变更，不建空分支')
    return undefined
  }

  private async resolvePrRemote(): Promise<string> {
    const configured = this.config.prConfig?.remote?.trim()
    if (configured)
      return configured
    const tracked = await this.git.pushTarget(this.config.companyBranch).catch(() => undefined)
    if (tracked)
      return tracked.remote
    if (await this.git.hasRemote('origin'))
      return 'origin'
    throw new GitError(t('e.prNeedsRemote'))
  }

  /**
   * Push the PR branch and, when the platform CLI is around, open the pull request.
   *
   * Nothing here may fail the run: the sync commit already exists locally, so a rejected push or
   * a missing `gh` is a note for the operator, not a broken tool.
   */
  private async publishPullRequest(results: SourceRunResult[]): Promise<PullRequestFacts> {
    const branch = this.prBranch as string
    const base = this.config.companyBranch
    const remote = await this.resolvePrRemote()
    const config = this.config.prConfig ?? { enable: true }
    const remoteUrl = await this.git.remoteUrl(remote)
    const url = compareUrl(remoteUrl, base, branch)
    const tool = toolForRemote(remoteUrl, config.tool)

    const facts: PullRequestFacts = { branch, baseBranch: base, remote, pushed: false, url: null }
    try {
      await this.git.push(remote, branch, { setUpstream: true })
      facts.pushed = true
    }
    catch (error) {
      facts.note = `推送 ${remote}/${branch} 失败：${toError(error).message}`
      logger.error(facts.note)
      for (const line of formatPrResult(facts)) logger.info(line)
      return facts
    }

    if (url)
      facts.url = url
    if (this.config.prConfig?.create !== 'never') {
      // Resolved per platform: on Windows the CLI is often only reachable as `gh.cmd`.
      const command = await findPrTool(tool, this.repoRoot)
      const outcome = await createPullRequest({
        cwd: this.repoRoot,
        head: branch,
        base,
        title: config.title ?? `chore(sync): 同步上游改动到 ${base}`,
        body: prBody(results, config, branch),
        ...(config.draft ? { draft: true } : {}),
        tool,
        ...(command ? { command } : {}),
      }, config)
      if (outcome.created) {
        facts.created = true
        facts.tool = outcome.tool
        if (outcome.url)
          facts.url = outcome.url
      }
      else if (outcome.attempted && outcome.error) {
        facts.tool = outcome.tool
        facts.note = outcome.error
      }
    }

    for (const line of formatPrResult(facts)) logger.info(line)
    return facts
  }

  /**
   * `autoSwitchBack` used to be a documented field nobody read: a run left the user on the
   * generated `feature/sync-…` branch. Returning is only safe once the work is committed,
   * which it always is at this point in the run.
   */
  private async switchBackIfNeeded(startedOn: string): Promise<void> {
    if (this.prBranch) {
      // The work is committed and pushed, and the target branch never moved — staying on the
      // PR branch would only surprise the next `git status`.
      const current = await this.git.currentBranch()
      if (startedOn !== 'HEAD' && current !== startedOn) {
        logger.info(`PR 模式：切回运行前所在分支 ${startedOn}`)
        await this.git.checkout(startedOn)
      }
      return
    }

    const strategy = this.config.branchStrategyConfig
    if (!strategy?.enable || strategy.autoSwitchBack === false)
      return
    const current = await this.git.currentBranch()
    if (current === startedOn || startedOn === 'HEAD')
      return
    logger.info(`分支策略 autoSwitchBack：切回运行前所在分支 ${startedOn}`)
    await this.git.checkout(startedOn)
  }

  /**
   * `autoDeleteMergedBranches` was likewise inert until now. Only branches this tool
   * generated (same pattern prefix), already merged into the target, and not currently
   * checked out are removed — `git branch -d` refuses anything unmerged.
   */
  private async deleteMergedBranchesIfEnabled(): Promise<void> {
    const strategy = this.config.branchStrategyConfig
    if (!strategy?.enable || !strategy.autoDeleteMergedBranches)
      return

    const prefix = strategy.branchPattern.slice(0, strategy.branchPattern.indexOf('{'))
    if (!prefix)
      return
    const current = await this.git.currentBranch()
    const keep = new Set([current, this.config.companyBranch, strategy.baseBranch])
    const merged = await this.git.mergedBranches(this.config.companyBranch)
    for (const branch of merged) {
      if (!branch.startsWith(prefix) || keep.has(branch))
        continue
      await this.git.deleteBranch(branch, false)
      logger.info(`分支策略：已删除合并完成的同步分支 ${branch}`)
    }
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

    const records: ConflictRecord[] = []
    const resolver = new ConflictResolver(config, {
      prompt: config.defaultStrategy === ConflictResolutionStrategy.PROMPT_USER ? this.prompt : undefined,
      onResolved: (record) => {
        records.push(record)
        logger.debug(`冲突已解决: ${record.path} → ${record.action}`)
      },
    })
    const base = await this.git.mergeBase(this.config.companyBranch, upstreamRef)
    const decisions = await resolver.resolve(
      plan.conflicts,
      createConflictContentSource({ git: this.git, repoRoot: this.repoRoot, upstreamRef, baseRef: base }),
    )
    for (const line of formatConflictReport(decisions)) logger.info(line)
    await this.writeResolutionLog(config.resolutionLogFile, records)
    return decisions
  }

  /**
   * `resolutionLogFile` was declared but never read, so "决策审计" only ever reached the
   * console. Written as JSONL in one awaited append: a per-record fire-and-forget append
   * can interleave or land after the process exits.
   */
  private async writeResolutionLog(file: string | undefined, records: ConflictRecord[]): Promise<void> {
    if (!file || records.length === 0)
      return
    try {
      const target = path.isAbsolute(file) ? file : path.join(this.repoRoot, file)
      await fs.ensureDir(path.dirname(target))
      const body = `${records.map(record => JSON.stringify({ at: new Date().toISOString(), ...record })).join('\n')}\n`
      await fs.appendFile(target, body, 'utf8')
      logger.verbose(`冲突决策已写入 ${target}（${records.length} 条）`)
    }
    catch (error) {
      logger.warn(`冲突决策日志写入失败（不影响本次结果）: ${toError(error).message}`)
    }
  }

  /**
   * Update this source's state file: which blobs the target branch now holds, which paths the
   * upstream dropped, and — when this run produced a commit — one append-only record that
   * `sync-upstream history` lists and `--undo` steps back over. Under fan-in every source keeps
   * its own file, so the records of one upstream never describe another one's commit.
   */
  private async persistState(
    source: SyncSource,
    applied: AppliedChange[],
    plan: SyncPlan,
    outcome: { commit: CommitResult, baseCommit: string, upstreamRef: string },
  ): Promise<void> {
    if (this.prBranch) {
      logger.debug(`PR 模式：跳过 ${source.stateFile} 的写入，改动只在 ${this.prBranch} 上`)
      return
    }
    try {
      const state = await this.loadState(source)
      state.record(applied)
      // Skipped deletions must not look "already synced" next run.
      const deleted = plan.changes.filter(entry => entry.kind === ChangeKind.DELETE).map(entry => entry.path)
      state.forget(deleted)

      if (outcome.commit.created && outcome.commit.hash) {
        const touched = applied.filter(item => item.status !== 'failed').map(item => item.entry.path)
        const revision = await this.git.resolveRef(outcome.upstreamRef).catch(() => '')
        state.recordSyncCommit({
          commit: outcome.commit.hash,
          source: `${source.remote}/${source.ref}`,
          ...(revision ? { upstreamOid: revision } : {}),
          files: outcome.commit.stagedCount,
          paths: [...new Set([...touched, ...deleted])].sort(),
          baseCommit: outcome.baseCommit,
          branch: await this.git.currentBranch().catch(() => this.config.companyBranch),
        })
      }

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
      throw new GitError(t('e.pushFailed', { remote: target.remote, branch: target.branch }), toError(error))
    }
  }
}

/**
 * Pull request description: one line per source with the counts the reviewer is asked to
 * approve, plus whatever the configuration wanted added.
 */
function prBody(results: SourceRunResult[], config: PrConfig, branch: string): string {
  const lines = [
    `由 sync-upstream 生成，改动都在 \`${branch}\` 上；目标分支未被修改。`,
    '',
    ...results.map((item) => {
      const summary = planSummary(item.plan)
      const commit = item.commit?.hash ? `，提交 \`${item.commit.hash.slice(0, 8)}\`` : ''
      return `- \`${item.label}\`（${item.kind}）：新增 ${summary.add}、修改 ${summary.modify}、重命名 ${summary.rename}、删除 ${summary.delete}${commit}`
    }),
    '',
    '合并前请检查冲突处理结果；本工具不会自行合并。',
  ]
  if (config.body)
    lines.push('', config.body)
  return lines.join('\n')
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
