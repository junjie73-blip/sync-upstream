# API 参考

包同时提供命令行 `sync-upstream` 和可编程调用的库入口，支持 CommonJS 与 ESM 两种引入方式。

```js
// CommonJS
const { runSync, resolveConfig } = require('sync-upstream')
```

```ts
import type { SyncConfig, SyncRunResult } from 'sync-upstream'
// TypeScript / ESM
import { resolveConfig, runSync } from 'sync-upstream'
```

## 公开导出一览

```text
// 入口
runSync, undoSync, UpstreamSyncer, UpstreamSyncerOptions

// 编排与计划
SyncOrchestrator, SyncRunResult, UPSTREAM_REMOTE, buildPlan

// 撤销
undoLastSync, UndoResult

// 只读子命令
statusCommand, whyCommand, doctorCommand, historyCommand, runSubcommand, SUBCOMMANDS, SUBCOMMAND_HELP
CommandContext, CommandOutput, StatusReport, WhyReport, DoctorReport, HistoryReport

// 通知
eventFromRun, eventFromUndo, eventFromFailure, notifyEnabled, notifyEvent, notifySafely, renderEvent, eventPlaceholders, formatNotifyResults

// git
GitRepository

// 配置
resolveConfig, loadConfig, DEFAULT_CONFIG, generateDefaultConfig

// 冲突
ConflictResolver, threeWayMerge

// 灰度
GrayController

// webhook
WebhookServer, createWebhookServer

// 忽略规则
IgnoreMatcher, compileIgnorePatterns, loadIgnoreMatcher

// 并发
createLimit, mapLimited, Limit

// 日志
logger, LogLevel

// 错误
SyncError 及全部子类（含新增的 LockError）, ErrorCode, ErrorSeverity, exitCodeFor, isSyncError, toError, formatUnknownError

// 领域类型与枚举
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

下文标注为内部的符号目前不能从包外引用；需要它们请提 issue 扩充导出。0.3.0 之后，只读子命令、撤销与通知相关符号已从包入口公开，可放心引用。

## 顶层入口

### runSync(options): Promise\<SyncRunResult\>

按已解析好的配置执行一次完整同步（拉取、生成计划、处理冲突、应用变更、提交，并在启用灰度时收尾、可选推送；命中 PR 模式时改为提交到生成的分支并交付评审）。运行成功或抛错之后，会按 `notifyConfig` 播报一次事件——除非 `options.notify` 传 `false`，或本次是预览运行（预览运行从不播报，见[通知钩子](#通知钩子)）。

```ts
interface UpstreamSyncerOptions {
  config: SyncConfig // 必须来自 resolveConfig / loadConfig，字段已补全且校验过
  cwd?: string // 目标仓库所在目录，默认 process.cwd()
  prompt?: ConflictPrompt // 仅在 defaultStrategy 为 'prompt-user' 时被调用
  confirmDeletes?: (count: number) => Promise<boolean> // 仅在 deletePolicy 为 'ask' 时被调用
  notify?: boolean // 传 false 时本次不播报，由调用方自行接管重试循环里的通知
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
console.log(result.plan.changes.length, '项变更；预览:', result.previewed)
```

### new UpstreamSyncer(options).run()

`runSync` 的类形式，`run()` 返回 `Promise<SyncRunResult>`，语义完全相同。类上另有 `undo()` 返回 `Promise<UndoResult>`。播报只发生在 `runSync` / `undoSync` 这层包装里；直接调用 `UpstreamSyncer` 的 `run()` 或 `undo()` 不会触发通知。

## SyncRunResult

```ts
interface SyncRunResult {
  plan: SyncPlan // 本次实际处理（灰度裁剪、多源合并后）的计划
  decisions: ConflictDecision[] // 冲突处置；预览运行为空数组
  applied?: ApplyResult // 预览运行时 undefined
  commit?: CommitResult // 预览运行时 undefined
  gray?: GrayReleaseStatus // 未启用灰度时 undefined
  pullRequest?: PullRequestFacts // 仅 prConfig 运行时有；类型名未对外导出，字段见下
  lfs?: LfsFacts // 命中 Git LFS 指针时给出，已跨源合并；没有则 undefined
  previewed: boolean // true 表示完全没有触碰工作区
  startedOn?: string // 运行开始时 HEAD 所在分支
  endedOn?: string // 运行结束（或失败）时 HEAD 所在分支
  sources: SourceRunResult[] // 每个上游一项；单源时长度 1，上面各字段就是它们的汇总
}

// sources 的每一项（SourceRunResult 类型名未对外导出）
interface SourceRunResultShape {
  label: string // `repo-name@ref`，日志与 history 用的名字
  repo: string
  ref: string // 配置里的引用：分支、标签或修订
  kind: 'branch' | 'tag' | 'revision'
  remote: string
  stateFile: string // 该源读写的状态文件（相对仓库根）
  plan: SyncPlan
  upstreamRef: string // 实际取文件用的本地引用
  decisions: ConflictDecision[]
  applied?: ApplyResult
  commit?: CommitResult
  previewed: boolean
  lfs?: LfsFacts
}

// pullRequest 的形状（PullRequestFacts 类型名未对外导出）
interface PullRequestFactsShape {
  branch: string // 同步提交落在的分支，目标分支未被移动
  baseBranch: string
  remote: string
  pushed: boolean
  url: string | null // 评审人可打开的 compare 链接；本地路径或未知主机为 null
  tool?: string // 被要求用 gh/glab 开 PR 时才有
  created?: boolean
  note?: string // 投递失败、缺少 CLI、分支重名等需要运维阅读的话
}

interface SyncPlan {
  upstreamRef: string // 例如 refs/remotes/sync-upstream/main
  targetBranch: string
  changes: ChangeEntry[] // { kind: 'add'|'modify'|'delete'|'rename', path, scope, upstreamOid?, targetOid?, fromPath?, similarity? }
  conflicts: ConflictCandidate[]
  skipped: SkippedEntry[] // { path, reason, detail? }
  dirty: RepoPath[] // 同步目录内本地已改动、未提交的路径
}

// SkippedEntry.reason 取值
type SkippedReason = 'ignored' | 'file-type' | 'already-synced' | 'outside-sync-dirs' | 'submodule' | 'symlink-unsupported' | 'delete-protected'

interface ApplyResult {
  applied: AppliedChange[] // { entry, status: 'applied' | 'kept-target' | 'failed', error? }
  stagedPaths: RepoPath[]
}

interface CommitResult {
  created: boolean
  hash?: string
  stagedCount: number
  reason?: string // created 为 false 时解释原因
}
```

计数：`planSummary(plan)` → `{ add, modify, delete, rename, conflict, skipped }`。

判断是否有文件失败：

```js
const failed = result.applied?.applied.filter(c => c.status === 'failed') ?? []
```

## 撤销同步

`--undo` 的库入口，撤销本工具记录的最近一次同步。它走的是 `git revert`（不改写共享分支），只有当记录的那次提交仍是 HEAD 时才生效；否则返回 `reverted: false` 并在 `reason` 里建议人工执行 `git revert <hash>`。多上游 fan-in 时，跨所有状态文件取时间最新的那条记录。

- `undoSync(options): Promise<UndoResult>` —— `runSync` 的撤销版，成功后按 `notifyConfig` 播报撤销事件（`options.notify` 为 `false` 时不播报）。
- `undoLastSync(context): Promise<UndoResult>` —— 不播报的裸实现；`context` 是 `{ git, config, repoRoot }`（`UndoContext` 类型名未对外导出）。

```ts
interface UndoResult {
  reverted: boolean
  target?: string // 被回退掉的那次同步提交
  commit?: string // 在其之上新生成的撤销提交
  branch?: string // 撤销发生的分支
  files: number // 该次同步触及的文件数
  reason?: string // 为什么什么都没做；reverted 为 false 不一定代表出错
}
```

## 通知钩子

`runSync` / `undoSync` 默认在真实（非预览）运行结束后按 `notifyConfig` 播报一次事件。投递永远不改变同步结果：聊天服务不可用不会把成功的同步变成失败，预览运行也从不播报。想自己掌握时机时，用下面这组导出把事件构出来再投递。

| 导出 | 签名 | 用途 |
|---|---|---|
| `eventFromRun` | `(config: SyncConfig, result: SyncRunResult, startedAt: number) => NotifyEvent` | 由一次运行结果生成事件，`outcome` 取 `success`/`noop`/`conflict`/`failure` |
| `eventFromUndo` | `(config: SyncConfig, result: UndoResult, startedAt: number) => NotifyEvent` | 由撤销结果生成，`outcome` 为 `undo` 或 `noop` |
| `eventFromFailure` | `(config: SyncConfig, error: unknown, startedAt: number) => NotifyEvent` | 由抛出的错误生成，`outcome` 为 `failure` |
| `notifyEnabled` | `(config: NotifyConfig \| undefined, outcome: SyncOutcome, isPreview: boolean) => boolean` | 是否应当播报：预览恒 `false`，`events` 未含该 `outcome` 也 `false` |
| `notifyEvent` | `(event: NotifyEvent, config?: NotifyConfig) => Promise<NotifyResult[]>` | 扇出到每个已配置渠道；`config` 未启用返回 `[]`，无渠道时回落 `stdout` |
| `notifySafely` | `(event: NotifyEvent, config?: NotifyConfig) => Promise<void>` | 投递并把逐渠道结果写日志，吞掉一切异常 |
| `renderEvent` | `(event: NotifyEvent, template?: string, includeDetails?: boolean) => string` | 渲染各渠道共用的纯文本正文 |
| `eventPlaceholders` | `(event: NotifyEvent) => Record<string, string>` | 模板可引用的占位变量 |
| `formatNotifyResults` | `(results: NotifyResult[]) => string[]` | 每个渠道一行的投递结果（中文） |

`renderEvent` 未给模板时的默认正文是中文，例如 `[sync-upstream] 同步成功`、`分支: main → company/main`、`变更 N 个文件 · 保留本地 … · 冲突 … · 跳过 …`；`NotifyEvent` 形状（由 `domain` 导出）：

```ts
interface NotifyEvent {
  outcome: 'success' | 'noop' | 'conflict' | 'failure' | 'undo'
  upstreamRepo: string // 已脱敏，绝不含带凭据的 URL；fan-in 时以 ` + ` 连接多个源
  upstreamBranch: string
  companyBranch: string
  syncDirs: string[]
  startedAt: string // ISO 字符串
  durationMs: number
  commit?: string
  applied?: number
  keptLocal?: number
  conflicts?: number
  skipped?: number
  sample?: string[] // 至多几个路径，让消息可操作而又不像日志转储
  pr?: { branch: string, baseBranch: string, pushed: boolean, created?: boolean, url?: string | null }
  error?: string
  cwd: string // 运行所在目录；一个 bot 服务多仓库时用于区分
}

interface NotifyResult {
  channel: NotifyChannel // 'stdout' | 'http' | 'slack' | 'dingtalk' | 'wecom'
  ok: boolean
  status?: number // 远程渠道的 HTTP 状态
  detail?: string // 失败原因：服务商返回体或异常消息
  attempts: number
}
```

`eventPlaceholders` 暴露的占位变量为 `{outcome}` `{upstream}` `{upstreamBranch}` `{companyBranch}` `{commit}` `{files}` `{kept}` `{conflicts}` `{skipped}` `{error}` `{duration}` `{dirs}` `{prBranch}` `{prUrl}`。

## 只读子命令

`sync-upstream status|why|doctor|history` 对应的四个处理器也已对外导出，供库调用方在不启动 CLI 的情况下拿到同样的机器文档。它们全部只读：不移动 HEAD、不改工作区、不写状态文件。每个处理器签名都是 `(context: CommandContext) => Promise<CommandOutput<XxxReport>>`，返回一份报告加要打印的行。

- `statusCommand` —— 每个上游当前的客观事实：本地引用、状态文件、仓库锁、可选的计划。
- `whyCommand` —— 针对单个路径解释“这次会不会同步它、为什么”，`context.positional[0]` 给出该路径。
- `doctorCommand` —— 环境与配置体检，逐项给出 `pass`/`warn`/`fail`/`info`。
- `historyCommand` —— 跨所有状态文件合并的同步历史，新→旧排序。

`runSubcommand` 会把 `context.configProblems` 逐条翻成报告 `warnings` 里的一行；`doctorCommand` 除此之外还把它变成一条 `fail` 检查，所以"配置还没配好"在体检里是阻塞项（退出码 1），而不是被悄悄跳过。

```ts
interface CommandContext {
  config: SyncConfig // 已解析的配置
  configSource: string | null // 配置文件绝对路径，用默认值时为 null
  cwd: string
  json: boolean
  positional: string[] // 子命令名之后的位置参数（why <path>）
  flags: { fetch: boolean, limit?: number }
  configProblems?: string[] // resolveConfig 的 problems；只读子命令据此把"缺了什么"写进报告
}

// CommandOutput<T>：report（--json 打印的正是它）与 lines（代替它的人类可读行）
// report 本身的类型名 CommandReport 未对外导出，其字段为：
// { command, ok, exitCode, generatedAt, data: T, warnings: string[], summary?: string }
```

报告 `data` 的字段（`StatusReport`/`WhyReport`/`DoctorReport`/`HistoryReport` 本身对外导出，但内嵌的 `RepoFacts`/`PlanFacts`/`StatusSource` 等类型名未导出）：

- `StatusReport`：`repo`（root/gitDir/currentBranch/head）、`targetBranch`、`config`（含 `deletePolicy`、`renameDetection`/`renameThreshold`、`fetch`{filter/depth/tags/lfs}、`notify`、`upstreams` 计数等）、`syncDirs`、`lock`、`sources`（每源 `{ label, repo, branch, kind, remote, remoteUrl?, dirs, ref, revision, lastFetchAt, state, plan, note? }`）。
- `WhyReport`：`path`、`verdict`（`'will-sync' | 'conflict' | 'skipped' | 'unchanged' | 'unknown-path'`）、逐条解释的 `reasons`、`scope`、`inUpstream`/`inTarget`、`basis`、可选 `change`/`state`/`ignoreRule`/`conflictType`/`action`、`workingTree`。
- `DoctorReport`：`repo`（或 null）、`checks`（每项 `{ id, level, message, hint? }`）、`counts`、`blocking`。
- `HistoryReport`：`files`（每个状态文件一项）、`exists`、`entries`、`total`、可选 `error`、`limit`、`records`（每条含 `commit`/`shortCommit`/`source`/`label`/`file`/`branch`/`syncedAt`/`files`/`paths`/`baseCommit`/`exists`/`isLastSync`）。

辅助导出：

- `runSubcommand(name, context): Promise<number>` —— 跑子命令并打印行或 JSON，返回进程退出码；`name` 取 `SUBCOMMANDS` 之一。
- `SUBCOMMANDS` —— `['status', 'why', 'doctor', 'history']` 常量元组。
- `SUBCOMMAND_HELP` —— `--help` 里各子命令那一行的 `{ name, usage, description }` 数组。

文案语言：报告的人类可读 `lines`、通知正文与错误 `describe()` 都经内置消息目录渲染，但 `setLocale` / `t` / `currentLocale` 不从包入口导出，库调用方无法切换语言。语言跟随进程环境（`SYNC_UPSTREAM_LANG`、`LC_ALL`、`LANG` 等，走 CLI 时生效），识别不了时回落中文；机器可读的 `report` 字段名始终是英文，不受影响。

## 配置 API

| 导出 | 签名 | 用途 |
|---|---|---|
| `resolveConfig` | `(raw: Record<string, unknown>, options?: { lenient?: boolean }) => { config: SyncConfig, warnings: string[], problems: string[] }` | 别名改写 + 与默认值合并 + 聚合校验；有问题时抛 `ValidationError`（一次列出全部）。传 `{ lenient: true }` 时不抛：`problems` 原样给出那些会让同步拒绝运行的问题，`config` 仍是可用的（`syncDirs` 会是空数组），只读子命令与 `--undo` 就是这样在没有配置时也能出报告的 |
| `loadConfig` | `(opts?: { configPath?: string, baseDir?: string }) => Promise<{ config, layer, source, warnings }>` | 读取配置文件；`configPath` 不存在/不可读/语法坏会抛 `ConfigError`，未找到任何文件则回落默认值并警告 |
| `DEFAULT_CONFIG` | `SyncConfig` | 全部默认值，`-g` 写的就是它 |
| `generateDefaultConfig` | `(filePath: string, format?: 'json' \| 'json5' \| 'yaml' \| 'toml') => Promise<string>` | 生成完整默认配置，返回绝对路径 |

`loadConfig` 返回的 `layer` 是**未校验**的文件自身字段（别名已改写为规范键）；校验发生在与命令行层合并之后，这样 `-d a,b` 能补上文件里漏掉的 `syncDirs`，而不是在读文件阶段就被拒。

## 编排与计划

```text
new SyncOrchestrator({ config, cwd?, prompt?, confirmDeletes? }).run(): Promise<SyncRunResult>
new SyncOrchestrator({ config, cwd?, prompt?, confirmDeletes? }).undo(): Promise<UndoResult>
```

需要自己算计划而不落地时：

```ts
import { buildPlan, GitRepository, loadIgnoreMatcher, UPSTREAM_REMOTE } from 'sync-upstream'

const git = new GitRepository(cwd)
await git.assertWorkTree()
await git.ensureRemote(UPSTREAM_REMOTE, upstreamRepo)
await git.fetch(UPSTREAM_REMOTE, upstreamBranch)

const { matcher } = await loadIgnoreMatcher({ repoRoot, scopes: syncDirs, configPatterns: ignorePatterns })
const plan = await buildPlan({ git, config, upstreamRef: `${UPSTREAM_REMOTE}/${branch}`, ignore: matcher })
```

`buildPlan` 只做只读比较，不改工作区、不切分支。

## GitRepository

`GitRepository` 封装了同步用到的 git 操作，失败统一包装成 `GitError` / `TimeoutError` 并附带人类可读提示；报错信息里的凭据型 URL 会先脱敏。

```ts
const git = new GitRepository(cwd, {
  env: { GIT_SSH_COMMAND: 'ssh -i ~/.ssh/id_ed25519 -o IdentitiesOnly=yes' },
})
```

第二个参数只有两项：`env`（为每个 git 操作附加环境变量，SSH 认证走这里）与 `onProgress`（git 操作的进度回调）。`GitRepositoryOptions` 类型未公开导出，可用的是 `GitRepository`。

| 方法 | 返回 | 说明 |
|---|---|---|
| `assertWorkTree()` / `repoRoot()` | `void` / `string` | 仓库检查 |
| `ensureRemote(name, url)` / `removeRemote(name)` / `hasRemote(name)` | — | 远端维护（URL 变化时 `set-url`） |
| `fetch(remote, ref)` | `void` | 拉取指定引用 |
| `refExists(ref)` / `resolveRef(ref)` / `head()` | `boolean` / `string` | 引用探测 |
| `currentBranch()` / `branchExists(name)` / `checkout(branch)` / `createBranch(name, start)` / `deleteBranch(name, force?)` | — | 分支操作 |
| `mergeBase(a, b)` | `string \| null` | 三方合并基准 |
| `listTree(ref, scopes?)` | `Map<RepoPath, { oid, mode }>` | 递归列出某引用下的文件，只保留普通文件（子模块指针被排除） |
| `locallyModifiedPaths(scopes)` / `untrackedPaths(scopes)` / `stagedPaths()` | `RepoPath[]` | 脏文件、未跟踪、暂存清单 |
| `readBlobText(ref, path)` | `string` | 读取某修订下的文件文本 |
| `checkoutPathsFromRef(ref, paths)` / `restorePathsFromHead(paths)` | — | 写入指定修订的内容 / 丢弃待提交改动（大批量路径会自动分批处理） |
| `removePaths(paths)` / `removeRecursive(paths)` | — | `git rm` 与 `-r` 版本 |
| `addPaths(paths)` / `commit(message, paths?)` / `push(remote, branch)` | hash | `commit` 传路径列表时只提交这些路径 |
| `pushTarget(branch)` | `{ remote, branch }` | 分支跟踪的上游，缺省 `origin/<branch>` |
| `exec(args)` | `string` | 未包装命令的逃生口 |

## 冲突 API

```text
new ConflictResolver(config: ConflictResolutionConfig, deps?: { prompt?, onResolved? })
  .resolve(candidates: ConflictCandidate[], contents: ConflictContentSource): Promise<ConflictDecision[]>

threeWayMerge(base: string | null, local: string | null, upstream: string | null): MergeOutcome
```

`deps` 的完整形状是 `{ prompt?: ConflictPrompt, onResolved?: (record: ConflictRecord) => void }`；`MergeOutcome` 与 `ConflictResolverDeps` 这两个类型目前未公开导出（`threeWayMerge` 的返回结构见下），需要引用名称时按下面的字面量自行声明。

```ts
interface MergeOutcome {
  status: 'clean' | 'conflict' | 'binary' | 'both-deleted'
  content?: string // clean 且为 undefined 表示结论是“文件被删除”
  conflictCount?: number // 仅 conflict 时有意义
}
```

约定：`null` 表示该侧不存在该文件。单侧超过约 2 万行时不做逐行合并，直接输出包裹整个文件的冲突标记。

`ConflictContentSource` 提供 `base` / `local` / `upstream` 三个异步取值函数，按需注入待合并的文件内容。

## 灰度 API

```ts
const gray = await GrayController.create({ git, repoRoot, config })
gray.restrict(plan, fullRelease) // 裁剪成金丝雀集合，或 fullRelease 时取 pending 集合
await gray.begin(plan, baseCommit) // 写 .sync-gray.json 并记审计
gray.record({ released, failed }) // 提供真实的失败/成功计数
await gray.finish(commit, fullRelease) // 校验 → completed / failed（可选自动回滚）
await gray.rollback() // --rollback 的入口
gray.status() // GrayReleaseStatus，只读视图
gray.releaseId / gray.pendingPaths
```

`GrayController.create` 要求 `config.grayReleaseConfig.enable === true`。灰度选择算法、状态文件与审计写入属于内部实现，不对外暴露。

## Webhook API

```ts
const server = createWebhookServer(webhookConfig, { onSync: async (delivery) => { /* … */ } })
const { port } = await server.start() // port 配 0 时返回系统分配端口
await server.stop() // 幂等，关闭活动连接，不会挂住进程
await server.handle(req, res) // 测试可直接注入 req/res，绕过 socket
```

平台识别、签名校验、事件过滤、IP 白名单与限流都在服务内完成，无需自行实现。行为契约见 [Webhook 守护模式](/guide/webhook)。

## 忽略规则 API

```ts
const { matcher, rules, files } = await loadIgnoreMatcher({ repoRoot, scopes, configPatterns })
matcher.isIgnored('src/a.spec.ts', false) // boolean
matcher.ruleFor('src/a.spec.ts') // 命中的规则，用于解释“为什么被忽略”
matcher.extend(moreRules) // 返回带附加规则的新 matcher

compileIgnorePatterns(['**/*.log', '!keep.log']) // IgnoreRule[]
const bare = new IgnoreMatcher(rules) // 直接以规则集构造
```

求值顺序与 gitignore 一致：后加入者胜出，因此 `loadIgnoreMatcher` 会把目录级嵌套的 `.gitignore` 放在最后应用。单条规则编译与忽略文件解析属于内部实现，对外的是上面这些入口。

## 并发 API

```ts
const limit = createLimit(8) // FIFO，最多 8 个并发，异常局部化
await limit(() => doWork())

await mapLimited(items, 8, async (item, index) => transform(item))
```

`createLimit(n)` 与 `mapLimited` 按 FIFO 调度、限制并发数，单个任务的异常不会影响其余任务。

## 日志与错误

```ts
import { logger, LogLevel } from 'sync-upstream'

logger.setLevel(LogLevel.VERBOSE)
logger.info('…') // trace/debug/verbose/info/success/perf/warn/error 单表过滤
```

错误类均继承 `SyncError`，带 `code`、`severity`、`originalError`、`context`、`timestamp`、`describe()`、`report()`：

| 类 | `ErrorCode` | `exitCodeFor` |
|---|---|---|
| `ConfigError`、`ValidationError` | `CONFIG_ERROR` / `VALIDATION_ERROR` | 2 |
| `GitError` | `GIT_ERROR` | 3 |
| `UserCancelError` | `USER_CANCEL` | 4 |
| `LockError` | `LOCK_ERROR`（severity `warning`） | 5 |
| `RepoPathError`、`FsError`、`ConflictError`、`PermissionError`、`SyncProcessError` | 各自代码 | 1 |
| `NetworkError`、`TimeoutError` | `NETWORK_ERROR` / `TIMEOUT_ERROR`（severity `warning`） | 1 |
| `AuthenticationError` | `AUTH_ERROR`（severity `critical`） | 1 |

辅助函数：`exitCodeFor(error)`、`isSyncError(value)`、`toError(value)`、`formatUnknownError(value)`。

## 与 CLI 的对应关系

命令行工具就是这套 API 的封装：把参数映射到配置、必要时交互补全（除非 `-y`），再调用 `runSync`、`undoSync`、某个只读子命令，或进入 webhook 守护模式。参数与配置键的逐项对应见 [命令行参考](/reference/cli)。请从包入口 `sync-upstream` 引用库能力；命令行入口文件在作为脚本执行时会自动运行并退出进程，不适合被直接引入。

## 状态文件

同步与灰度过程写入的运行产物文件，其内部字段格式不从包入口导出。落点、身份绑定规则与“哪些可以安全删除”统一记录在 [配置参考的运行产物与清理](/reference/configuration#运行产物与清理)。`--undo` 与 `history` 正是读取这些文件的记录来工作的。
