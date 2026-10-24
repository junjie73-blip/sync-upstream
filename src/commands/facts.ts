import type { SyncConfig } from '../domain'
import type { IgnoreMatcher } from '../fsx/ignore-rules'
import type { SyncSource } from '../pipeline/sources'
import type { LockFacts, PlanFacts, RepoFacts, StateFacts } from './types'
import path from 'node:path'
import fs from 'fs-extra'
import { planSummary } from '../domain'
import { toError } from '../errors'
import { loadIgnoreMatcher } from '../fsx/ignore-source'
import { sshCommand } from '../git/auth'
import { GitRepository } from '../git/repository'
import { toClonableUrl } from '../git/url'
import { buildPlan } from '../pipeline/plan'
import { DEFAULT_STALE_AFTER_MS, isProcessAlive, isStale, readRepoLock, REPO_LOCK_FILE } from '../pipeline/repo-lock'
import { sourcesOf } from '../pipeline/sources'
import { SyncState } from '../pipeline/sync-state'
import { fetchSource, findSourceRef } from '../pipeline/upstream-ref'

/** Read-only view of everything the subcommands need, assembled once. */
export interface SourceFacts {
  /** The upstream this block describes. */
  source: SyncSource
  /** Local ref the plan reads, null when nothing has been fetched for this source. */
  upstreamRef: string | null
  upstreamRevision: string | null
  /** When this source's ref last changed on disk. */
  lastFetchAt: string | null
  state: StateFacts
  /** The state as the pipeline would load it (identity-checked, v1 migrated) — for `why`. */
  syncState: SyncState
  /** Ignore rules as the planner sees them — `why` quotes the matching rule back. */
  ignore: IgnoreMatcher
  plan: PlanFacts | null
}

export interface Facts {
  git: GitRepository
  config: SyncConfig
  repo: RepoFacts
  lock: LockFacts
  /** One entry per configured upstream; a plain single-upstream config has exactly one. */
  sources: SourceFacts[]
  warnings: string[]
}

export interface CollectOptions {
  /** Fetch the upstream first; without it `status` reports the last revision already on disk. */
  fetch?: boolean
}

export function openRepository(config: SyncConfig, cwd: string): GitRepository {
  return new GitRepository(cwd, { env: sshCommand(config.authConfig, cwd) })
}

/** Repo + `.git` + HEAD, tolerant of detached HEAD. */
export async function readRepoFacts(git: GitRepository): Promise<RepoFacts> {
  await git.assertWorkTree()
  const [root, gitDir, head] = await Promise.all([
    git.repoRoot(),
    git.gitDirectory(),
    git.head(),
  ])
  const currentBranch = await git.currentBranch().catch(() => 'HEAD')
  return { root, gitDir, currentBranch, head }
}

/**
 * When a ref last arrived on disk: the loose ref file's mtime, falling back to `FETCH_HEAD`
 * for refs that were packed away. `status` and `why` are deliberately offline — fetching is
 * opt-in, and the plan below always reads what is already there.
 */
export async function readFetchTime(gitDir: string, ref: string | null): Promise<string | null> {
  if (ref) {
    const loose = await fs.stat(path.join(gitDir, ...ref.split('/'))).catch(() => undefined)
    if (loose)
      return new Date(loose.mtimeMs).toISOString()
  }
  const fetched = await fs.stat(path.join(gitDir, 'FETCH_HEAD')).catch(() => undefined)
  return fetched ? new Date(fetched.mtimeMs).toISOString() : null
}

export async function readUpstreamFacts(git: GitRepository, source: SyncSource): Promise<{ ref: string | null, revision: string | null }> {
  const ref = await findSourceRef(git, source.remote, source.source)
  if (!ref)
    return { ref: null, revision: null }
  return { ref, revision: await git.resolveRef(ref).catch(() => null) }
}

/** Fetch one source into its dedicated remote, exactly like a real run would. */
export async function fetchSourceObjects(git: GitRepository, config: SyncConfig, source: SyncSource): Promise<void> {
  await git.ensureRemote(source.remote, toClonableUrl(source.repo, config.authConfig))
  await fetchSource(git, source.remote, source.source, source.repo, config.retryConfig, config.fetchConfig)
}

/**
 * Read a state file as written, without the identity check `SyncState.load` applies —
 * diagnostics have to be able to report *why* a state file is being ignored.
 */
export async function readStateFacts(repoRoot: string, source: SyncSource, companyBranch: string): Promise<StateFacts> {
  const file = path.join(repoRoot, source.stateFile)
  const identity = {
    upstreamRepo: source.repo,
    upstreamBranch: source.ref,
    companyBranch,
  }
  const blank: StateFacts = {
    file,
    exists: false,
    version: null,
    readable: true,
    identityMatches: false,
    identity,
    entries: 0,
    lastSyncedAt: null,
    lastSyncCommit: null,
    history: 0,
  }

  if (!(await fs.pathExists(file)))
    return blank

  let data: Record<string, any>
  try {
    data = await fs.readJson(file)
  }
  catch (error) {
    return { ...blank, exists: true, readable: false, error: (error as Error).message }
  }

  const entries = data.entries as Record<string, { syncedAt?: string }> | undefined
  const history = Array.isArray(data.history) ? data.history as Array<{ syncedAt?: string }> : []
  const stamped = [
    ...Object.values(entries ?? {}).map(entry => entry?.syncedAt),
    ...history.map(record => record?.syncedAt),
  ].filter((value): value is string => typeof value === 'string')

  return {
    file,
    exists: true,
    version: typeof data.version === 'number' ? data.version : 1,
    readable: true,
    identityMatches: data.upstreamRepo === identity.upstreamRepo
      && data.upstreamBranch === identity.upstreamBranch
      && (data.version === 1 || data.companyBranch === identity.companyBranch),
    identity: {
      upstreamRepo: typeof data.upstreamRepo === 'string' ? data.upstreamRepo : '',
      upstreamBranch: typeof data.upstreamBranch === 'string' ? data.upstreamBranch : '',
      companyBranch: typeof data.companyBranch === 'string' ? data.companyBranch : '',
    },
    entries: Object.keys(entries ?? {}).length,
    lastSyncedAt: stamped.length > 0 ? stamped.sort()[stamped.length - 1] : null,
    lastSyncCommit: typeof data.lastSyncCommit === 'string' ? data.lastSyncCommit : null,
    history: history.length,
  }
}

/** Who holds the repository lock, and whether that holder looks dead. */
export async function readLockFacts(gitDir: string): Promise<LockFacts> {
  const file = path.join(gitDir, REPO_LOCK_FILE)
  const record = await readRepoLock(gitDir)
  if (!record)
    return { file, held: false }
  const stale = isStale(record, Date.now(), isProcessAlive, DEFAULT_STALE_AFTER_MS)
  return {
    file,
    held: true,
    holder: {
      pid: record.pid,
      label: record.label,
      createdAt: Number.isFinite(record.createdAt) ? new Date(record.createdAt).toISOString() : 'unknown',
      stale,
    },
  }
}

/**
 * Ignore rules plus the identity-checked state file — the two inputs `buildPlan` reads
 * besides the trees, and the two things `why` has to quote back to explain a verdict.
 */
export async function readPlanInputs(
  repoRoot: string,
  config: SyncConfig,
  source: SyncSource,
): Promise<{ ignore: IgnoreMatcher, syncState: SyncState }> {
  const file = path.join(repoRoot, source.stateFile)
  const identity = {
    upstreamRepo: source.repo,
    upstreamBranch: source.ref,
    companyBranch: config.companyBranch,
  }
  const [{ matcher }, syncState] = await Promise.all([
    loadIgnoreMatcher({
      repoRoot,
      scopes: source.dirs,
      configPatterns: config.ignorePatterns,
    }),
    // A state file that cannot be parsed is exactly what `status`/`why`/`doctor` are supposed
    // to tell you about; letting it throw would replace the diagnosis with a stack trace.
    SyncState.load(file, identity).catch(() => SyncState.empty(file, identity)),
  ])
  return { ignore: matcher, syncState }
}

/**
 * The same plan a real run would compute, from the refs already on disk. Nothing here moves
 * HEAD or touches the working tree.
 */
export async function readPlanFacts(
  git: GitRepository,
  config: SyncConfig,
  source: SyncSource,
  upstreamRef: string | null,
  inputs: { ignore: IgnoreMatcher, syncState: SyncState },
): Promise<PlanFacts | null> {
  if (!upstreamRef)
    return null
  if (!(await git.branchExists(config.companyBranch)) && !(await git.refExists(`refs/remotes/origin/${config.companyBranch}`)))
    return null

  const plan = await buildPlan({
    git,
    config: { ...config, syncDirs: source.dirs },
    upstreamRef,
    ignore: inputs.ignore,
    state: config.forceOverwrite ? undefined : inputs.syncState,
    symlinksSupported: await git.supportsSymlinks(),
  })

  const summary = planSummary(plan)
  return {
    summary,
    changes: plan.changes,
    conflicts: plan.conflicts.map(conflict => ({ path: conflict.path, conflictType: conflict.conflictType })),
    skipped: plan.skipped.map(item => ({ path: item.path, reason: item.reason, ...(item.detail ? { detail: item.detail } : {}) })),
    dirty: plan.dirty,
    upstreamCommitsAhead: await git.countCommitsBetween(config.companyBranch, upstreamRef),
    targetCommitsAhead: await git.countCommitsBetween(upstreamRef, config.companyBranch),
  }
}

async function readSourceFacts(
  git: GitRepository,
  config: SyncConfig,
  repo: RepoFacts,
  source: SyncSource,
  warnings: string[],
): Promise<SourceFacts> {
  const upstream = await readUpstreamFacts(git, source)
  const lastFetchAt = await readFetchTime(repo.gitDir, upstream.ref)
  const [state, inputs] = await Promise.all([
    readStateFacts(repo.root, source, config.companyBranch),
    readPlanInputs(repo.root, config, source),
  ])

  let plan: PlanFacts | null = null
  try {
    plan = await readPlanFacts(git, config, source, upstream.ref, inputs)
  }
  catch (error) {
    warnings.push(`计划计算失败（${source.label}）: ${toError(error).message}`)
  }

  if (!state.readable)
    warnings.push(`FAIL 状态文件无法解析: ${state.file} — ${state.error}；下面的计划按“尚无增量记录”计算`)
  if (state.exists && !state.identityMatches)
    warnings.push(`状态文件属于另一个上游/分支组合，本次会被忽略并重新全量同步（${source.stateFile}）`)

  return {
    source,
    upstreamRef: upstream.ref,
    upstreamRevision: upstream.revision,
    lastFetchAt,
    state,
    syncState: inputs.syncState,
    ignore: inputs.ignore,
    plan,
  }
}

/**
 * Collect everything `status` / `why` / `doctor` share. Failures of individual parts degrade
 * into warnings — a diagnostic command that throws because the state file is corrupt is
 * exactly the command that needs to tell you about that file.
 */
export async function collectFacts(
  config: SyncConfig,
  cwd: string,
  options: CollectOptions = {},
): Promise<Facts> {
  const git = openRepository(config, cwd)
  const warnings: string[] = []
  const repo = await readRepoFacts(git)
  const sources = sourcesOf(config)

  if (options.fetch) {
    for (const source of sources) {
      try {
        await fetchSourceObjects(git, config, source)
      }
      catch (error) {
        warnings.push(`拉取上游失败（${source.label}），以下计划基于本地已有数据: ${toError(error).message}`)
      }
    }
  }

  const facts: SourceFacts[] = []
  for (const source of sources)
    facts.push(await readSourceFacts(git, config, repo, source, warnings))

  return { git, config, repo, lock: await readLockFacts(repo.gitDir), sources: facts, warnings }
}
