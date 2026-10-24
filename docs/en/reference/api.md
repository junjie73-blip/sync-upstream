# API reference

The package ships both the `sync-upstream` command line and a programmatic library entry, importable from CommonJS and ESM alike.

```js
// CommonJS
const { runSync, resolveConfig } = require('sync-upstream')
```

```ts
import type { SyncConfig, SyncRunResult } from 'sync-upstream'
// TypeScript / ESM
import { resolveConfig, runSync } from 'sync-upstream'
```

## Public exports

```text
// Entry points
runSync, undoSync, UpstreamSyncer, UpstreamSyncerOptions

// Orchestration and planning
SyncOrchestrator, SyncRunResult, UPSTREAM_REMOTE, buildPlan

// Undo
undoLastSync, UndoResult

// Read-only subcommands
statusCommand, whyCommand, doctorCommand, historyCommand, runSubcommand, SUBCOMMANDS, SUBCOMMAND_HELP
CommandContext, CommandOutput, StatusReport, WhyReport, DoctorReport, HistoryReport

// Notification
eventFromRun, eventFromUndo, eventFromFailure, notifyEnabled, notifyEvent, notifySafely, renderEvent, eventPlaceholders, formatNotifyResults

// git
GitRepository

// Configuration
resolveConfig, loadConfig, DEFAULT_CONFIG, generateDefaultConfig

// Conflicts
ConflictResolver, threeWayMerge

// Gray release
GrayController

// webhook
WebhookServer, createWebhookServer

// Ignore rules
IgnoreMatcher, compileIgnorePatterns, loadIgnoreMatcher

// Concurrency
createLimit, mapLimited, Limit

// Logging
logger, LogLevel

// Errors
SyncError and all subclasses (including the new LockError), ErrorCode, ErrorSeverity, exitCodeFor, isSyncError, toError, formatUnknownError

// Domain types and enums
SyncConfig, RawSyncConfig, RepoPath, ChangeKind, ChangeEntry, RenamePair, SkippedEntry, SkipReason, SyncPlan,
AppliedChange, ApplyResult, CommitResult, planSummary,
ConflictType, ConflictResolutionStrategy, ConflictCandidate, ConflictDecision,
ConflictAction, ConflictPrompt, ConflictContentSource, ConflictRecord, ConflictResolutionConfig,
BranchStrategy, BranchStrategyConfig,
DeletePolicy, DELETE_POLICIES, DEFAULT_RENAME_THRESHOLD, PrConfig,
PartialFilter, PARTIAL_FILTERS, LfsMode, LFS_MODES, FetchConfig, DEFAULT_FETCH_CONFIG, filterArg, LfsFacts,
NotifyChannel, NotifyConfig, NotifyEvent, NotifyResult, SyncOutcome, NOTIFY_CHANNELS, SYNC_OUTCOMES,
UpstreamSource,
LogConfig, LogFileLevel, LOG_FILE_LEVELS, DEFAULT_LOG_CONFIG,
GrayReleaseStrategy, GrayReleaseStage, GrayReleaseConfig, GrayReleaseStatus, GrayReleaseSelection,
GrayReleaseAlertThresholds,
WebhookPlatform, WebhookConfig, WebhookDelivery, WebhookSecurityConfig, WebhookRateLimit, WebhookEventFilterRule,
AuthType, AuthConfig, RetryConfig
```

Symbols marked as internal below cannot be referenced from outside the package today; if you need one of them, open an issue to have it exported. Since 0.3.0 the read-only subcommands, undo, and notification symbols are public from the package entry and are safe to import.

## Entry points

### runSync(options): Promise\<SyncRunResult\>

Runs one complete sync from an already resolved configuration: fetch, build the plan, handle conflicts, apply changes, commit, then wrap up the gray release when it is enabled and push if asked to (a pull-request-mode run instead commits onto a generated branch and hands off for review). Once the run succeeds or throws, it announces one event through `notifyConfig` — unless `options.notify` is `false`, or the run was a preview (preview runs never announce; see [notification hooks](#notification-hooks)).

```ts
interface UpstreamSyncerOptions {
  config: SyncConfig // must come from resolveConfig / loadConfig: fields already completed and validated
  cwd?: string // directory of the target repository, defaults to process.cwd()
  prompt?: ConflictPrompt // only called when defaultStrategy is 'prompt-user'
  confirmDeletes?: (count: number) => Promise<boolean> // only called when deletePolicy is 'ask'
  notify?: boolean // false suppresses this run's announcement, for callers that own the retry loop
}
```

```js
const { runSync, resolveConfig } = require('sync-upstream')

const { config, warnings } = resolveConfig({
  upstreamRepo: 'https://github.com/vuejs/core.git',
  upstreamBranch: 'main',
  companyBranch: 'company/main',
  syncDirs: ['packages/shared'],
  previewOnly: true,
})
warnings.forEach(w => console.warn(w))

const result = await runSync({ config, cwd: process.cwd() })
console.log(result.plan.changes.length, 'change(s); previewed:', result.previewed)
```

### new UpstreamSyncer(options).run()

The class form of `runSync`; `run()` returns `Promise<SyncRunResult>` and behaves exactly the same. The class also exposes `undo()` returning `Promise<UndoResult>`. Announcing happens only in the `runSync` / `undoSync` wrappers; calling `UpstreamSyncer`'s `run()` or `undo()` directly never fires a notification.

## SyncRunResult

```ts
interface SyncRunResult {
  plan: SyncPlan // the plan actually processed in this run (after gray trimming and multi-source merge)
  decisions: ConflictDecision[] // how conflicts were handled; empty array in a preview run
  applied?: ApplyResult // undefined in a preview run
  commit?: CommitResult // undefined in a preview run
  gray?: GrayReleaseStatus // undefined when gray release is not enabled
  pullRequest?: PullRequestFacts // only for a prConfig run; the type name is not exported, shape below
  lfs?: LfsFacts // present when the run met Git LFS pointers, merged over every source; undefined otherwise
  previewed: boolean // true means the working tree was not touched at all
  startedOn?: string // branch HEAD was on when the run started
  endedOn?: string // branch HEAD is on when the run finished (or failed)
  sources: SourceRunResult[] // one entry per upstream; length 1 for a single source, and the fields above are their aggregate
}

// each entry of sources (the SourceRunResult type name is not exported)
interface SourceRunResultShape {
  label: string // `repo-name@ref`, the name the log and history use
  repo: string
  ref: string // the ref as configured: a branch, a tag, or a revision
  kind: 'branch' | 'tag' | 'revision'
  remote: string
  stateFile: string // the state file this source reads and writes, relative to the repo root
  plan: SyncPlan
  upstreamRef: string // the local ref the files were actually taken from
  decisions: ConflictDecision[]
  applied?: ApplyResult
  commit?: CommitResult
  previewed: boolean
  lfs?: LfsFacts
}

// the shape of pullRequest (the PullRequestFacts type name is not exported)
interface PullRequestFactsShape {
  branch: string // the branch the sync commits landed on; the target branch never moved
  baseBranch: string
  remote: string
  pushed: boolean
  url: string | null // the compare page a reviewer can open; null for a local-path remote or unknown host
  tool?: string // only when gh/glab was asked to open the PR
  created?: boolean
  note?: string // anything the operator should read: a failed push, a missing CLI, a reused branch
}

interface SyncPlan {
  upstreamRef: string // e.g. refs/remotes/sync-upstream/main
  targetBranch: string
  changes: ChangeEntry[] // { kind: 'add'|'modify'|'delete'|'rename', path, scope, upstreamOid?, targetOid?, fromPath?, similarity? }
  conflicts: ConflictCandidate[]
  skipped: SkippedEntry[] // { path, reason, detail? }
  dirty: RepoPath[] // paths inside the sync directories with uncommitted local changes
}

// the values of SkippedEntry.reason
type SkippedReason = 'ignored' | 'file-type' | 'already-synced' | 'outside-sync-dirs' | 'submodule' | 'symlink-unsupported' | 'delete-protected'

interface ApplyResult {
  applied: AppliedChange[] // { entry, status: 'applied' | 'kept-target' | 'failed', error? }
  stagedPaths: RepoPath[]
}

interface CommitResult {
  created: boolean
  hash?: string
  stagedCount: number
  reason?: string // explains the reason when created is false
}
```

Counts: `planSummary(plan)` → `{ add, modify, delete, rename, conflict, skipped }`.

To tell whether any file failed:

```js
const failed = result.applied?.applied.filter(c => c.status === 'failed') ?? []
```

## Undo

The library entry behind `--undo`: it steps back over the most recent sync this tool recorded. It runs `git revert` (it does not rewrite a shared branch) and only succeeds while the recorded commit is still HEAD; otherwise it returns `reverted: false` and its `reason` suggests running `git revert <hash>` by hand. Under multi-upstream fan-in it picks the newest record across every state file.

- `undoSync(options): Promise<UndoResult>` — the undo counterpart of `runSync`; after a real undo it announces an event through `notifyConfig` (suppressed when `options.notify` is `false`).
- `undoLastSync(context): Promise<UndoResult>` — the raw, non-announcing implementation; `context` is `{ git, config, repoRoot }` (the `UndoContext` type name is not exported).

```ts
interface UndoResult {
  reverted: boolean
  target?: string // the sync commit that was stepped back over
  commit?: string // the new revert commit created on top of it
  branch?: string // the branch the undo happened on
  files: number // how many files that sync touched
  reason?: string // why nothing happened; reverted: false is not always an error
}
```

## Notification hooks

By default `runSync` / `undoSync` announce one event through `notifyConfig` after a real (non-preview) run finishes. Announcing never changes the outcome: a chat provider being down cannot turn a good sync into a failed one, and preview runs are never announced. To control the timing yourself, build an event with these exports and deliver it.

| Export | Signature | Purpose |
|---|---|---|
| `eventFromRun` | `(config: SyncConfig, result: SyncRunResult, startedAt: number) => NotifyEvent` | Builds the event from a run result; `outcome` is `success`/`noop`/`conflict`/`failure` |
| `eventFromUndo` | `(config: SyncConfig, result: UndoResult, startedAt: number) => NotifyEvent` | Builds from an undo result; `outcome` is `undo` or `noop` |
| `eventFromFailure` | `(config: SyncConfig, error: unknown, startedAt: number) => NotifyEvent` | Builds from a thrown error; `outcome` is `failure` |
| `notifyEnabled` | `(config: NotifyConfig \| undefined, outcome: SyncOutcome, isPreview: boolean) => boolean` | Whether to announce: always `false` for a preview, and `false` when `events` omits that `outcome` |
| `notifyEvent` | `(event: NotifyEvent, config?: NotifyConfig) => Promise<NotifyResult[]>` | Fans out to every configured channel; returns `[]` when `config` is disabled, and falls back to `stdout` when no channel is set |
| `notifySafely` | `(event: NotifyEvent, config?: NotifyConfig) => Promise<void>` | Delivers and logs each per-channel result, swallowing any exception |
| `renderEvent` | `(event: NotifyEvent, template?: string, includeDetails?: boolean) => string` | Renders the plain-text body shared by every channel |
| `eventPlaceholders` | `(event: NotifyEvent) => Record<string, string>` | The placeholder variables a template may reference |
| `formatNotifyResults` | `(results: NotifyResult[]) => string[]` | One delivery line per channel (in Chinese) |

When no template is given, `renderEvent`'s default body is Chinese, e.g. `` `[sync-upstream] 同步成功` `` ("sync succeeded"), `` `分支: main → company/main` `` ("branch: main → company/main"), `` `变更 N 个文件 · 保留本地 … · 冲突 … · 跳过 …` `` ("N files changed · kept local … · conflicts … · skipped …"). The `NotifyEvent` shape (exported from `domain`):

```ts
interface NotifyEvent {
  outcome: 'success' | 'noop' | 'conflict' | 'failure' | 'undo'
  upstreamRepo: string // redacted, never a token-bearing URL; fan-in joins several sources with ` + `
  upstreamBranch: string
  companyBranch: string
  syncDirs: string[]
  startedAt: string // ISO string
  durationMs: number
  commit?: string
  applied?: number
  keptLocal?: number
  conflicts?: number
  skipped?: number
  sample?: string[] // a few paths at most, so the message is actionable without being a log dump
  pr?: { branch: string, baseBranch: string, pushed: boolean, created?: boolean, url?: string | null }
  error?: string
  cwd: string // where the run happened; useful when one bot serves many repositories
}

interface NotifyResult {
  channel: NotifyChannel // 'stdout' | 'http' | 'slack' | 'dingtalk' | 'wecom'
  ok: boolean
  status?: number // HTTP status for the remote channels
  detail?: string // failure reason: provider body or error message
  attempts: number
}
```

`eventPlaceholders` exposes `{outcome}`, `{upstream}`, `{upstreamBranch}`, `{companyBranch}`, `{commit}`, `{files}`, `{kept}`, `{conflicts}`, `{skipped}`, `{error}`, `{duration}`, `{dirs}`, `{prBranch}`, `{prUrl}`.

## Read-only subcommands

The four handlers behind `sync-upstream status|why|doctor|history` are also exported, so library callers get the same machine-readable documents without starting the CLI. They are all read-only: they never move HEAD, touch the working tree, or write a state file. Every handler has the signature `(context: CommandContext) => Promise<CommandOutput<XxxReport>>`, returning one report plus the lines to print.

- `statusCommand` — the current objective facts per upstream: local ref, state file, repository lock, and an optional plan.
- `whyCommand` — for a single path, explains whether it would sync and why; `context.positional[0]` is that path.
- `doctorCommand` — environment and configuration health check, reporting each item as `pass`/`warn`/`fail`/`info`.
- `historyCommand` — sync history merged across every state file, newest first.

`runSubcommand` turns each entry of `context.configProblems` into a line of the report's `warnings`; `doctorCommand` additionally makes it a `fail` check, so "the configuration is not finished yet" shows up as a blocker (exit code 1) instead of being quietly skipped.

```ts
interface CommandContext {
  config: SyncConfig // a resolved configuration
  configSource: string | null // absolute path of the config file, null when defaults were used
  cwd: string
  json: boolean
  positional: string[] // positional arguments after the subcommand name (why <path>)
  flags: { fetch: boolean, limit?: number }
  configProblems?: string[] // the `problems` from resolveConfig; the read-only commands report what is missing from these
}

// CommandOutput<T>: report (exactly what --json prints) and lines (the human-readable stand-in)
// The report's own type name CommandReport is not exported; its fields are:
// { command, ok, exitCode, generatedAt, data: T, warnings: string[], summary?: string }
```

The `data` field of each report (`StatusReport`/`WhyReport`/`DoctorReport`/`HistoryReport` are exported themselves, but embedded type names like `RepoFacts`/`PlanFacts`/`StatusSource` are not):

- `StatusReport`: `repo` (root/gitDir/currentBranch/head), `targetBranch`, `config` (includes `deletePolicy`, `renameDetection`/`renameThreshold`, `fetch`{filter/depth/tags/lfs}, `notify`, the `upstreams` count, and more), `syncDirs`, `lock`, `sources` (one `{ label, repo, branch, kind, remote, remoteUrl?, dirs, ref, revision, lastFetchAt, state, plan, note? }` per source).
- `WhyReport`: `path`, `verdict` (`'will-sync' | 'conflict' | 'skipped' | 'unchanged' | 'unknown-path'`), per-factor `reasons`, `scope`, `inUpstream`/`inTarget`, `basis`, optional `change`/`state`/`ignoreRule`/`conflictType`/`action`, and `workingTree`.
- `DoctorReport`: `repo` (or null), `checks` (each `{ id, level, message, hint? }`), `counts`, `blocking`.
- `HistoryReport`: `files` (one per state file), `exists`, `entries`, `total`, optional `error`, `limit`, `records` (each with `commit`/`shortCommit`/`source`/`label`/`file`/`branch`/`syncedAt`/`files`/`paths`/`baseCommit`/`exists`/`isLastSync`).

Helper exports:

- `runSubcommand(name, context): Promise<number>` — runs a subcommand and prints either its lines or one JSON document, returning the process exit code; `name` is one of `SUBCOMMANDS`.
- `SUBCOMMANDS` — the `['status', 'why', 'doctor', 'history']` const tuple.
- `SUBCOMMAND_HELP` — the `{ name, usage, description }` array that backs each subcommand's row in `--help`.

Message language: the human-readable `lines` of a report, the notification body, and an error's `describe()` all render through the built-in message catalog, but `setLocale` / `t` / `currentLocale` are not exported from the package entry, so a library caller cannot switch the language. It follows the process environment (`SYNC_UPSTREAM_LANG`, `LC_ALL`, `LANG`, and so on, which take effect when the tool runs through the CLI) and falls back to Chinese when it cannot tell; the machine-readable `report` field names are always English and are unaffected.

## Configuration API

| Export | Signature | Purpose |
|---|---|---|
| `resolveConfig` | `(raw: Record<string, unknown>, options?: { lenient?: boolean }) => { config: SyncConfig, warnings: string[], problems: string[] }` | Alias rewriting + merging with the defaults + aggregated validation; throws `ValidationError` listing every problem at once. With `{ lenient: true }` it never throws: `problems` carries the issues that would stop a sync and `config` is still usable (`syncDirs` comes back empty) — which is how the read-only subcommands and `--undo` produce a report without a configuration |
| `loadConfig` | `(opts?: { configPath?: string, baseDir?: string }) => Promise<{ config, layer, source, warnings }>` | Reads a configuration file; a `configPath` that is missing, unreadable, or syntactically broken throws `ConfigError`, while finding no file at all falls back to the defaults with a warning |
| `DEFAULT_CONFIG` | `SyncConfig` | All default values; this is what `-g` writes |
| `generateDefaultConfig` | `(filePath: string, format?: 'json' \| 'json5' \| 'yaml' \| 'toml') => Promise<string>` | Generates the complete default configuration and returns the absolute path |

The `layer` returned by `loadConfig` contains the file's own fields and is **not validated** (aliases have already been rewritten to canonical keys). Validation runs after the file layer has been merged with the command-line layer, so that `-d a,b` can supply a `syncDirs` the file left out instead of being refused while the file is read.

## Orchestration and planning

```text
new SyncOrchestrator({ config, cwd?, prompt?, confirmDeletes? }).run(): Promise<SyncRunResult>
new SyncOrchestrator({ config, cwd?, prompt?, confirmDeletes? }).undo(): Promise<UndoResult>
```

When you want to compute the plan yourself without applying anything:

```ts
import { buildPlan, GitRepository, loadIgnoreMatcher, UPSTREAM_REMOTE } from 'sync-upstream'

const git = new GitRepository(cwd)
await git.assertWorkTree()
await git.ensureRemote(UPSTREAM_REMOTE, upstreamRepo)
await git.fetch(UPSTREAM_REMOTE, upstreamBranch)

const { matcher } = await loadIgnoreMatcher({ repoRoot, scopes: syncDirs, configPatterns: ignorePatterns })
const plan = await buildPlan({ git, config, upstreamRef: `${UPSTREAM_REMOTE}/${branch}`, ignore: matcher })
```

`buildPlan` only performs read-only comparisons: it changes no file in the working tree and switches no branch.

## GitRepository

`GitRepository` wraps the git operations the sync needs. Failures are wrapped into `GitError` / `TimeoutError` with a human-readable hint, and credential-bearing URLs in error messages are redacted first.

```ts
const git = new GitRepository(cwd, {
  env: { GIT_SSH_COMMAND: 'ssh -i ~/.ssh/id_ed25519 -o IdentitiesOnly=yes' },
})
```

The second argument has exactly two fields: `env` (environment variables added to every git operation; SSH authentication goes through here) and `onProgress` (a progress callback for git operations). The `GitRepositoryOptions` type is not exported from the package entry, so refer to `GitRepository` itself.

| Method | Returns | Notes |
|---|---|---|
| `assertWorkTree()` / `repoRoot()` | `void` / `string` | Repository checks |
| `ensureRemote(name, url)` / `removeRemote(name)` / `hasRemote(name)` | — | Remote maintenance (`set-url` when the URL changed) |
| `fetch(remote, ref)` | `void` | Fetch the given ref |
| `refExists(ref)` / `resolveRef(ref)` / `head()` | `boolean` / `string` | Ref probing |
| `currentBranch()` / `branchExists(name)` / `checkout(branch)` / `createBranch(name, start)` / `deleteBranch(name, force?)` | — | Branch operations |
| `mergeBase(a, b)` | `string \| null` | Three-way merge base |
| `listTree(ref, scopes?)` | `Map<RepoPath, { oid, mode }>` | List the files under a ref recursively, keeping regular files only (submodule pointers are excluded) |
| `locallyModifiedPaths(scopes)` / `untrackedPaths(scopes)` / `stagedPaths()` | `RepoPath[]` | Dirty, untracked, and staged path lists |
| `readBlobText(ref, path)` | `string` | Read the text of a file at a given revision |
| `checkoutPathsFromRef(ref, paths)` / `restorePathsFromHead(paths)` | — | Write the content of a given revision / discard uncommitted changes (large path lists are split into batches automatically) |
| `removePaths(paths)` / `removeRecursive(paths)` | — | `git rm` and its `-r` variant |
| `addPaths(paths)` / `commit(message, paths?)` / `push(remote, branch)` | hash | When `commit` receives a path list, only those paths are committed |
| `pushTarget(branch)` | `{ remote, branch }` | The upstream the branch tracks, `origin/<branch>` by default |
| `exec(args)` | `string` | Escape hatch for unwrapped commands |

## Conflict API

```text
new ConflictResolver(config: ConflictResolutionConfig, deps?: { prompt?, onResolved? })
  .resolve(candidates: ConflictCandidate[], contents: ConflictContentSource): Promise<ConflictDecision[]>

threeWayMerge(base: string | null, local: string | null, upstream: string | null): MergeOutcome
```

The full shape of `deps` is `{ prompt?: ConflictPrompt, onResolved?: (record: ConflictRecord) => void }`. The `MergeOutcome` and `ConflictResolverDeps` types are not exported from the package entry (the return shape of `threeWayMerge` is below), so declare them yourself from the literals below when you need the names.

```ts
interface MergeOutcome {
  status: 'clean' | 'conflict' | 'binary' | 'both-deleted'
  content?: string // for a clean outcome, undefined means the result is "the file was deleted"
  conflictCount?: number // only meaningful for conflict
}
```

Convention: `null` means the file does not exist on that side. When one side exceeds about 20 000 lines, no line-by-line merge is attempted and conflict markers wrapping the whole file are written instead.

`ConflictContentSource` provides the three async getters `base` / `local` / `upstream`, injecting the file content to be merged on demand.

## Gray release API

```ts
const gray = await GrayController.create({ git, repoRoot, config })
gray.restrict(plan, fullRelease) // trim to the canary set, or take the pending set when fullRelease
await gray.begin(plan, baseCommit) // write .sync-gray.json and record the audit entry
gray.record({ released, failed }) // feed the real failure/success counts
await gray.finish(commit, fullRelease) // validate -> completed / failed (optional automatic rollback)
await gray.rollback() // the entry point behind --rollback
gray.status() // GrayReleaseStatus, a read-only view
gray.releaseId / gray.pendingPaths
```

`GrayController.create` requires `config.grayReleaseConfig.enable === true`. The gray selection algorithm, the state file, and the audit writer are internal implementation and are not exposed.

## Webhook API

```ts
const server = createWebhookServer(webhookConfig, { onSync: async (delivery) => { /* … */ } })
const { port } = await server.start() // with port configured as 0 this returns the system-assigned port
await server.stop() // idempotent, closes active connections, never hangs the process
await server.handle(req, res) // tests can inject req/res directly and bypass the socket
```

Platform detection, signature verification, event filtering, IP allow-listing, and rate limiting all happen inside the server; you do not have to implement any of them. For the behavioural contract see [Webhook daemon](/en/guide/webhook).

## Ignore rules API

```ts
const { matcher, rules, files } = await loadIgnoreMatcher({ repoRoot, scopes, configPatterns })
matcher.isIgnored('src/a.spec.ts', false) // boolean
matcher.ruleFor('src/a.spec.ts') // the rule that matched, used to explain why a path was ignored
matcher.extend(moreRules) // a new matcher with the extra rules applied

compileIgnorePatterns(['**/*.log', '!keep.log']) // IgnoreRule[]
const bare = new IgnoreMatcher(rules) // construct directly from a rule set
```

Evaluation order matches gitignore: later entries win, which is why `loadIgnoreMatcher` applies nested `.gitignore` files inside directories last. Only the entry points above are public; compiling a single rule and parsing an ignore file are internal implementation.

## Concurrency API

```ts
const limit = createLimit(8) // FIFO, at most 8 concurrent, exceptions localized
await limit(() => doWork())

await mapLimited(items, 8, async (item, index) => transform(item))
```

`createLimit(n)` and `mapLimited` schedule FIFO while capping the concurrency, and an exception in one task does not affect the others.

## Logging and errors

```ts
import { logger, LogLevel } from 'sync-upstream'

logger.setLevel(LogLevel.VERBOSE)
logger.info('…') // one filter table across trace/debug/verbose/info/success/perf/warn/error
```

Every error class extends `SyncError` and carries `code`, `severity`, `originalError`, `context`, `timestamp`, `describe()`, and `report()`:

| Class | `ErrorCode` | `exitCodeFor` |
|---|---|---|
| `ConfigError`, `ValidationError` | `CONFIG_ERROR` / `VALIDATION_ERROR` | 2 |
| `GitError` | `GIT_ERROR` | 3 |
| `UserCancelError` | `USER_CANCEL` | 4 |
| `LockError` | `LOCK_ERROR` (severity `warning`) | 5 |
| `RepoPathError`, `FsError`, `ConflictError`, `PermissionError`, `SyncProcessError` | their own codes | 1 |
| `NetworkError`, `TimeoutError` | `NETWORK_ERROR` / `TIMEOUT_ERROR` (severity `warning`) | 1 |
| `AuthenticationError` | `AUTH_ERROR` (severity `critical`) | 1 |

Helpers: `exitCodeFor(error)`, `isSyncError(value)`, `toError(value)`, `formatUnknownError(value)`.

## Mapping to the CLI

The command line tool is a wrapper around this API: it maps flags onto configuration, completes what is missing interactively (unless `-y` is given), then calls `runSync`, `undoSync`, one of the read-only subcommands, or enters webhook daemon mode. The flag-by-flag and key-by-key correspondence is in the [CLI reference](/en/reference/cli). Take library capabilities from the package entry `sync-upstream`; the CLI entry file runs itself and exits the process when executed as a script, so it is not meant to be imported directly.

## State files

The runtime files written while syncing and during gray releases expose no field types from the package entry, so do not parse them in your own code. Where they land, how they are bound to an identity, and which of them are safe to delete are documented together in [runtime files and cleanup in the configuration reference](/en/reference/configuration#runtime-files-and-cleanup). Both `--undo` and `history` read those files' records to do their work.
