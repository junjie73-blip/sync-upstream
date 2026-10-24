import type { ChangeEntry, DeletePolicy, LfsFacts, RepoPath, SyncConfig } from '../domain'
import type { PullRequestFacts } from '../pipeline/pr'

/** Envelope every command produces; `--json` prints exactly this object. */
export interface CommandReport<T> {
  command: 'status' | 'why' | 'doctor' | 'history' | 'sync' | 'undo'
  ok: boolean
  /** Process exit code the CLI will return for this report. */
  exitCode: number
  generatedAt: string
  data: T
  warnings: string[]
  /** Markdown written to `$GITHUB_STEP_SUMMARY`, kept in the report so `--json` users can log it. */
  summary?: string
}

export interface RepoFacts {
  root: string
  gitDir: string
  currentBranch: string
  head: string
}

export interface PlanFacts {
  summary: { add: number, modify: number, delete: number, rename: number, conflict: number, skipped: number }
  changes: ChangeEntry[]
  conflicts: Array<{ path: RepoPath, conflictType: string, detail?: string }>
  skipped: Array<{ path: RepoPath, reason: string, detail?: string }>
  dirty: RepoPath[]
  /** Upstream commits the target branch does not have yet. */
  upstreamCommitsAhead: number | null
  /** Local commits on the target branch that upstream does not have. */
  targetCommitsAhead: number | null
}

export interface StateFacts {
  file: string
  exists: boolean
  version: number | null
  readable: boolean
  /** False when the file belongs to another (upstream repo, branch, target branch) triple. */
  identityMatches: boolean
  identity: { upstreamRepo: string, upstreamBranch: string, companyBranch: string }
  entries: number
  lastSyncedAt: string | null
  lastSyncCommit: string | null
  history: number
  error?: string
}

export interface LockFacts {
  file: string
  held: boolean
  holder?: { pid: number, label: string, createdAt: string, stale: boolean }
}

/**
 * One upstream as `status` sees it. A config without `upstreams` produces exactly one of these,
 * so the single-upstream shape is just the N=1 case of the multi-upstream one.
 */
export interface StatusSource {
  /** `repo-name@ref`, the label the log and `history` use. */
  label: string
  repo: string
  /** Ref as configured — a branch, a tag, or a revision. */
  branch: string
  kind: 'branch' | 'tag' | 'revision'
  remote: string
  remoteUrl?: string
  dirs: RepoPath[]
  /** Local ref the plan reads, null when this source was never fetched. */
  ref: string | null
  revision: string | null
  lastFetchAt: string | null
  state: StateFacts
  plan: PlanFacts | null
  /** Why `plan` is null, in operator words. */
  note?: string
}

export interface StatusReport {
  repo: RepoFacts
  targetBranch: string
  config: ConfigFacts
  syncDirs: RepoPath[]
  lock: LockFacts
  /** Every upstream this run would sync. */
  sources: StatusSource[]
}

export interface ConfigFacts {
  source: string | null
  syncDirs: RepoPath[]
  forceOverwrite: boolean
  previewOnly: boolean
  dryRun: boolean
  autoPush: boolean
  nonInteractive: boolean
  verbose: boolean
  silent: boolean
  lockWaitMs: number
  concurrencyLimit: number
  ignorePatterns: string[]
  includeFileTypes: string[]
  conflictStrategy: string
  /** What a run does with files the upstream dropped. */
  deletePolicy: DeletePolicy
  renameDetection: boolean
  renameThreshold: number
  /**
   * How much of the upstream a run pulls in. Always present: on a big repository this is the
   * first thing to check when a sync is slow, and `status --json` should say it without being asked.
   */
  fetch: {
    filter: string
    depth: number | null
    tags: boolean
    lfs: string
  }
  /** Set when `prConfig` turns the run into a pull request. */
  prMode?: string
  resolutionLogFile?: string
  branchStrategy?: string
  grayRelease?: string
  webhook?: string
  /** Channels and events, so `status --json` shows what a run would announce. */
  notify?: string
  /** How many upstreams fan into this target branch. Absent means one. */
  upstreams?: number
  authType?: string
}

export type CheckLevel = 'pass' | 'warn' | 'fail' | 'info'

export interface DoctorCheck {
  id: string
  level: CheckLevel
  message: string
  hint?: string
}

export interface DoctorReport {
  repo: RepoFacts | null
  checks: DoctorCheck[]
  counts: Record<CheckLevel, number>
  blocking: number
}

export interface HistoryEntryOut {
  commit: string
  shortCommit: string
  source: string
  /** `repo-name@ref` of the upstream this record belongs to. */
  label: string
  /** State file the record was read from. */
  file: string
  branch: string
  syncedAt: string
  files: number
  paths: RepoPath[]
  baseCommit: string
  /** False once the commit has been garbage-collected or the branch rewritten. */
  exists: boolean
  /** True when this record is what `--undo` would step back over. */
  isLastSync: boolean
}

/** One state file as `history` read it. A single-upstream repository has exactly one. */
export interface HistoryFileFacts {
  file: string
  label: string
  exists: boolean
  readable: boolean
  identity: { upstreamRepo: string, upstreamBranch: string, companyBranch: string }
  /** Incremental entries, i.e. files this source already knows it synced. */
  entries: number
  /** History records in the file. */
  total: number
  error?: string
}

export interface HistoryReport {
  files: HistoryFileFacts[]
  /** True when at least one state file was found. */
  exists: boolean
  /** Incremental entries across every file. */
  entries: number
  /** Records across every file, before `--limit`. */
  total: number
  /** Parse failure of the first unreadable file, kept for `--json` consumers of 0.2.x. */
  error?: string
  limit: number
  /** Newest first, merged across sources. */
  records: HistoryEntryOut[]
}

export type Verdict
  = | 'will-sync'
    | 'conflict'
    | 'skipped'
    | 'unchanged'
    | 'unknown-path'

export interface WhyReport {
  path: RepoPath
  verdict: Verdict
  /** Human sentences, one per factor that contributed to the verdict. */
  reasons: string[]
  scope: RepoPath | null
  inUpstream: boolean
  inTarget: boolean
  basis: { label: string, ref: string | null, revision: string | null, lastFetchAt: string | null }
  change?: ChangeEntry
  state?: { upstreamOid: string, mode?: string, syncedAt: string } | null
  ignoreRule?: { pattern: string, source: string, base: RepoPath, negated: boolean } | null
  workingTree: { exists: boolean, modified: boolean, untracked: boolean, staged: boolean }
  conflictType?: string
  action?: string
}

/** Result of a `--json` sync run; mirrors what the human log says. */
export interface SyncReportData {
  previewed: boolean
  startedOn: string | undefined
  endedOn: string | undefined
  plan: PlanFacts
  applied: { applied: number, keptTarget: number, failed: number, list: Array<{ path: RepoPath, status: string, error?: string }> }
  commit: { created: boolean, hash?: string, files: number, reason?: string }
  failed: Array<{ path: RepoPath, error: string }>
  gray?: { releaseId: string, stage: string, progress: number }
  /** Set for a `prConfig` run: where the commits went and what the reviewer can open. */
  pullRequest?: PullRequestFacts
  /** Set when a run met Git LFS pointers: what landed, and whether the content arrived. */
  lfs?: LfsFacts
  /** One entry per upstream. Equal to the fields above when a single source ran. */
  sources: SyncSourceReport[]
}

export interface SyncSourceReport {
  label: string
  repo: string
  ref: string
  kind: 'branch' | 'tag' | 'revision'
  remote: string
  stateFile: string
  plan: PlanFacts
  applied: SyncReportData['applied']
  commit: SyncReportData['commit']
  previewed: boolean
  /** This source's Git LFS findings, when it had any. */
  lfs?: LfsFacts
}

export interface CommandContext {
  config: SyncConfig
  configSource: string | null
  cwd: string
  json: boolean
  /** Positional arguments after the subcommand name (`why <path>`). */
  positional: string[]
  flags: { fetch: boolean, limit?: number }
  /**
   * Everything that would stop a real sync with this configuration, collected instead of thrown
   * because the read-only diagnostics run on a broken config on purpose. `doctor` turns it into a
   * failing check; every report repeats it under `warnings`, so a clean-looking report can never
   * hide a missing upstream.
   */
  configProblems?: string[]
}

/** Every command returns the machine document plus the lines to show instead of it. */
export interface CommandOutput<T> {
  report: CommandReport<T>
  lines: string[]
}
