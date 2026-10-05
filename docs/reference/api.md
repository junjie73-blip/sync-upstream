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
runSync, UpstreamSyncer, UpstreamSyncerOptions

// 编排与计划
SyncOrchestrator, SyncRunResult, UPSTREAM_REMOTE, buildPlan

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
SyncError 及全部子类, ErrorCode, ErrorSeverity, exitCodeFor, isSyncError, toError, formatUnknownError

// 领域类型与枚举
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

下文标注为内部的符号目前不能从包外引用；需要它们请提 issue 扩充导出。

## 顶层入口

### runSync(options): Promise\<SyncRunResult\>

按已解析好的配置执行一次完整同步（拉取、生成计划、处理冲突、应用变更、提交，并在启用灰度时收尾、可选推送）。

```ts
interface UpstreamSyncerOptions {
  config: SyncConfig // 必须来自 resolveConfig / loadConfig，字段已补全且校验过
  cwd?: string // 目标仓库所在目录，默认 process.cwd()
  prompt?: ConflictPrompt // 仅在 defaultStrategy 为 'prompt-user' 时被调用
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

`runSync` 的类形式，语义完全相同。

## SyncRunResult

```ts
interface SyncRunResult {
  plan: SyncPlan // 本次实际处理（灰度裁剪后）的计划
  decisions: ConflictDecision[] // 冲突处置；预览运行为空数组
  applied?: ApplyResult // 预览运行时 undefined
  commit?: CommitResult // 预览运行时 undefined
  gray?: GrayReleaseStatus // 未启用灰度时 undefined
  previewed: boolean // true 表示完全没有触碰工作区
}

interface SyncPlan {
  upstreamRef: string // 例如 refs/remotes/sync-upstream/main
  targetBranch: string
  changes: ChangeEntry[] // { kind: 'add'|'modify'|'delete', path, scope, upstreamOid?, targetOid? }
  conflicts: ConflictCandidate[]
  skipped: SkippedEntry[] // { path, reason: 'ignored' | 'file-type' | 'already-synced' | 'outside-sync-dirs' }
  dirty: RepoPath[] // 同步目录内本地已改动、未提交的路径
}

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

计数：`planSummary(plan)` → `{ add, modify, delete, conflict, skipped }`。

判断是否有文件失败：

```js
const failed = result.applied?.applied.filter(c => c.status === 'failed') ?? []
```

## 配置 API

| 导出 | 签名 | 用途 |
|---|---|---|
| `resolveConfig` | `(raw: Record<string, unknown>) => { config: SyncConfig, warnings: string[] }` | 别名改写 + 与默认值合并 + 聚合校验；有问题时抛 `ValidationError`（一次列出全部） |
| `loadConfig` | `(opts?: { configPath?: string, baseDir?: string }) => Promise<{ config, layer, source, warnings }>` | 读取配置文件；`configPath` 不存在/不可读/语法坏会抛 `ConfigError`，未找到任何文件则回落默认值并警告 |
| `DEFAULT_CONFIG` | `SyncConfig` | 全部默认值，`-g` 写的就是它 |
| `generateDefaultConfig` | `(filePath: string, format?: 'json' \| 'json5' \| 'yaml' \| 'toml') => Promise<string>` | 生成完整默认配置，返回绝对路径 |

`loadConfig` 返回的 `layer` 是**未校验**的文件自身字段（别名已改写为规范键）；校验发生在与命令行层合并之后，这样 `-d a,b` 能补上文件里漏掉的 `syncDirs`，而不是在读文件阶段就被拒。

## 编排与计划

```text
new SyncOrchestrator({ config, cwd?, prompt? }).run(): Promise<SyncRunResult>
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
  content?: string // clean 且为 undefined 表示结论是"文件被删除"
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

错误类均继承 `SyncError`，带 `code`、`severity`、`originalError`、`context`、`describe()`、`report()`：

| 类 | `ErrorCode` | `exitCodeFor` |
|---|---|---|
| `ConfigError`、`ValidationError` | `CONFIG_ERROR` / `VALIDATION_ERROR` | 2 |
| `GitError` | `GIT_ERROR` | 3 |
| `UserCancelError` | `USER_CANCEL` | 4 |
| `RepoPathError`、`FsError`、`ConflictError`、`PermissionError`、`SyncProcessError` | 各自代码 | 1 |
| `NetworkError`、`TimeoutError` | `NETWORK_ERROR` / `TIMEOUT_ERROR`（severity `warning`） | 1 |
| `AuthenticationError` | `AUTH_ERROR`（severity `critical`） | 1 |

辅助函数：`exitCodeFor(error)`、`isSyncError(value)`、`toError(value)`、`formatUnknownError(value)`。

## 与 CLI 的对应关系

命令行工具就是这套 API 的封装：把参数映射到配置、必要时交互补全（除非 `-y`），再调用 `runSync` 或进入 webhook 守护模式。参数与配置键的逐项对应见 [命令行参考](/reference/cli)。请从包入口 `sync-upstream` 引用库能力；命令行入口文件在作为脚本执行时会自动运行并退出进程，不适合被直接引入。

## 状态文件

同步与灰度过程写入的运行产物文件，其内部字段格式不从包入口导出。落点、身份绑定规则与"哪些可以安全删除"统一记录在 [配置参考的运行产物与清理](/reference/configuration#运行产物与清理)。
