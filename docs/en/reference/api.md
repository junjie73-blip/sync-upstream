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
runSync, UpstreamSyncer, UpstreamSyncerOptions

// Orchestration and planning
SyncOrchestrator, SyncRunResult, UPSTREAM_REMOTE, buildPlan

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
SyncError and all subclasses, ErrorCode, ErrorSeverity, exitCodeFor, isSyncError, toError, formatUnknownError

// Domain types and enums
SyncConfig, RawSyncConfig, RepoPath, ChangeKind, ChangeEntry, SyncPlan, SkippedEntry,
AppliedChange, ApplyResult, CommitResult, planSummary,
ConflictType, ConflictResolutionStrategy, ConflictCandidate, ConflictDecision,
ConflictAction, ConflictPrompt, ConflictContentSource, ConflictRecord, ConflictResolutionConfig,
BranchStrategy, BranchStrategyConfig,
GrayReleaseStrategy, GrayReleaseStage, GrayReleaseConfig, GrayReleaseStatus, GrayReleaseSelection,
GrayReleaseAlertThresholds,
WebhookPlatform, WebhookConfig, WebhookDelivery, WebhookSecurityConfig, WebhookRateLimit, WebhookEventFilterRule,
AuthType, AuthConfig, RetryConfig
```

Symbols marked as internal below cannot be referenced from outside the package today; if you need one of them, open an issue to have it exported.

## Entry points

### runSync(options): Promise\<SyncRunResult\>

Runs one complete sync from an already resolved configuration: fetch, build the plan, handle conflicts, apply changes, commit, then wrap up the gray release when it is enabled and push if asked to.

```ts
interface UpstreamSyncerOptions {
  config: SyncConfig // must come from resolveConfig / loadConfig: fields already completed and validated
  cwd?: string // directory of the target repository, defaults to process.cwd()
  prompt?: ConflictPrompt // only called when defaultStrategy is 'prompt-user'
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

The class form of `runSync`; the semantics are exactly the same.

## SyncRunResult

```ts
interface SyncRunResult {
  plan: SyncPlan // the plan actually processed in this run (after gray trimming)
  decisions: ConflictDecision[] // how conflicts were handled; empty array in a preview run
  applied?: ApplyResult // undefined in a preview run
  commit?: CommitResult // undefined in a preview run
  gray?: GrayReleaseStatus // undefined when gray release is not enabled
  previewed: boolean // true means the working tree was not touched at all
}

interface SyncPlan {
  upstreamRef: string // e.g. refs/remotes/sync-upstream/main
  targetBranch: string
  changes: ChangeEntry[] // { kind: 'add'|'modify'|'delete', path, scope, upstreamOid?, targetOid? }
  conflicts: ConflictCandidate[]
  skipped: SkippedEntry[] // { path, reason: 'ignored' | 'file-type' | 'already-synced' | 'outside-sync-dirs' }
  dirty: RepoPath[] // paths inside the sync directories with uncommitted local changes
}

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

Counts: `planSummary(plan)` → `{ add, modify, delete, conflict, skipped }`.

To tell whether any file failed:

```js
const failed = result.applied?.applied.filter(c => c.status === 'failed') ?? []
```

## Configuration API

| Export | Signature | Purpose |
|---|---|---|
| `resolveConfig` | `(raw: Record<string, unknown>) => { config: SyncConfig, warnings: string[] }` | Alias rewriting + merging with the defaults + aggregated validation; throws `ValidationError` listing every problem at once |
| `loadConfig` | `(opts?: { configPath?: string, baseDir?: string }) => Promise<{ config, layer, source, warnings }>` | Reads a configuration file; a `configPath` that is missing, unreadable or syntactically broken throws `ConfigError`, while finding no file at all falls back to the defaults with a warning |
| `DEFAULT_CONFIG` | `SyncConfig` | All default values; this is what `-g` writes |
| `generateDefaultConfig` | `(filePath: string, format?: 'json' \| 'json5' \| 'yaml' \| 'toml') => Promise<string>` | Generates the complete default configuration and returns the absolute path |

The `layer` returned by `loadConfig` contains the file's own fields and is **not validated** (aliases have already been rewritten to canonical keys). Validation runs after the file layer has been merged with the command-line layer, so that `-d a,b` can supply a `syncDirs` the file left out instead of being refused while the file is read.

## Orchestration and planning

```text
new SyncOrchestrator({ config, cwd?, prompt? }).run(): Promise<SyncRunResult>
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
| `locallyModifiedPaths(scopes)` / `untrackedPaths(scopes)` / `stagedPaths()` | `RepoPath[]` | Dirty, untracked and staged path lists |
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
  content?: string // for clean, undefined means the outcome is "the file was deleted"
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

`GrayController.create` requires `config.grayReleaseConfig.enable === true`. Beyond the calls above there is nothing supported from outside: do not depend on the selection algorithm, the `.sync-gray.json` fields, or the audit writer — read the state through `gray.status()` instead.

## Webhook API

```ts
const server = createWebhookServer(webhookConfig, { onSync: async (delivery) => { /* … */ } })
const { port } = await server.start() // with port configured as 0 this returns the system-assigned port
await server.stop() // idempotent, closes active connections, never hangs the process
await server.handle(req, res) // tests can inject req/res directly and bypass the socket
```

Platform detection, signature verification, event filtering, IP allow-listing and rate limiting all happen inside the server; you do not have to implement any of them. For the behavioural contract see [Webhook daemon](/en/guide/webhook).

## Ignore rules API

```ts
const { matcher, rules, files } = await loadIgnoreMatcher({ repoRoot, scopes, configPatterns })
matcher.isIgnored('src/a.spec.ts', false) // boolean
matcher.ruleFor('src/a.spec.ts') // the rule that matched, used to explain why a path was ignored
matcher.extend(moreRules) // a new matcher with the extra rules applied

compileIgnorePatterns(['**/*.log', '!keep.log']) // IgnoreRule[]
const bare = new IgnoreMatcher(rules) // construct directly from a rule set
```

Evaluation order matches gitignore: later entries win, which is why `loadIgnoreMatcher` applies nested `.gitignore` files inside directories last. Only the entry points above are supported; there is no public API for compiling a single rule or parsing an ignore file.

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

Every error class extends `SyncError` and carries `code`, `severity`, `originalError`, `context`, `describe()` and `report()`:

| Class | `ErrorCode` | `exitCodeFor` |
|---|---|---|
| `ConfigError`, `ValidationError` | `CONFIG_ERROR` / `VALIDATION_ERROR` | 2 |
| `GitError` | `GIT_ERROR` | 3 |
| `UserCancelError` | `USER_CANCEL` | 4 |
| `RepoPathError`, `FsError`, `ConflictError`, `PermissionError`, `SyncProcessError` | their own codes | 1 |
| `NetworkError`, `TimeoutError` | `NETWORK_ERROR` / `TIMEOUT_ERROR` (severity `warning`) | 1 |
| `AuthenticationError` | `AUTH_ERROR` (severity `critical`) | 1 |

Helpers: `exitCodeFor(error)`, `isSyncError(value)`, `toError(value)`, `formatUnknownError(value)`.

## Mapping to the CLI

The command line tool is a wrapper around this API: it maps flags onto configuration, completes what is missing interactively (unless `-y` is given), then calls `runSync` or enters webhook daemon mode. The flag-by-flag and key-by-key correspondence is in the [CLI reference](/en/reference/cli). Take library capabilities from the package entry `sync-upstream`; the CLI entry file runs itself and exits the process when executed as a script, so it is not meant to be imported directly.

## State files

The runtime files written while syncing and during gray releases expose no field types from the package entry, so do not parse them in your own code. Where they land, how they are bound to an identity, and which of them are safe to delete are documented together in [runtime files and cleanup in the configuration reference](/en/reference/configuration#runtime-files-and-cleanup).
