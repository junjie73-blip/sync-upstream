# 配置参考

本页逐项列出 `SyncConfig` 的规范字段。配置文件、命令行、编程 API 用的是**同一套键名**；历史别名见 [配置指南的别名小节](/guide/configuration#别名与废弃键)。

类型可从包直接导入：

```ts
import type { GrayReleaseConfig, SyncConfig, WebhookConfig } from 'sync-upstream'
```

## 顶层字段

| 字段 | 类型 | 默认值 | 命令行 | 说明 |
|---|---|---|---|---|
| `upstreamRepo` | `string` | `''`（必填） | `-r, --repo` | 上游仓库地址 |
| `upstreamBranch` | `string` | `'main'` | `-b, --branch` | 同步的上游 ref：分支、标签或提交号都可以，需要明确时用 `refs/heads/…`、`refs/tags/…` 前缀 |
| `companyBranch` | `string` | `'main'` | `-c, --company-branch` | 目标分支（本地/`origin` 必须已存在） |
| `syncDirs` | `string[]` | `[]`（必填非空） | `-d, --dirs` | 同步范围，仓库根相对路径；既匹配目录也匹配同名文件 |
| `upstreams` | `UpstreamSource[]` | 未设置 | 重复 `-r` / `-b` | 多上游 fan-in，见[多上游](#多上游-upstreams) |
| `commitMessage` | `string` | `'Sync upstream changes to specified directories'` | `-m, --message` | 提交消息 |
| `autoPush` | `boolean` | `false` | `-p, --push` | 提交后推送；`dryRun` 为真时被强制关闭并警告，`prConfig` 开启时同样关闭 |
| `forceOverwrite` | `boolean` | `true` | `-f, --force` / `--incremental` | `true` 应用全部计划；`false` 依据 `.sync-state.json` 增量 |
| `deletePolicy` | `'mirror'` / `'keep'` / `'ask'` | `'mirror'` | `--delete-policy`、`--delete` / `--no-delete` | 上游删掉、目标分支还有的文件怎么处理，见[删除与改名](#删除与改名) |
| `renameDetection` | `boolean` | `true` | `--renames` / `--no-renames` | 上游改名是否合成一次移动 |
| `renameThreshold` | `number` | `60` | `--rename-threshold` | 相似度百分比（1–100 整数），低于它的删除/新增配对视为两个文件 |
| `verbose` | `boolean` | `false` | `-V, --verbose` | 提升日志等级并输出完整变更清单 |
| `silent` | `boolean` | `false` | `-s, --silent` | 只输出错误 |
| `dryRun` | `boolean` | `false` | `-n, --dry-run` | 试运行，等价于 `previewOnly` |
| `previewOnly` | `boolean` | `false` | `-P, --preview-only` | 只打印计划 |
| `nonInteractive` | `boolean` | `false` | `-y, --non-interactive` | 不提问；`prompt-user` 降级为 `keep-target` |
| `concurrencyLimit` | `number` | `10` | `--concurrency` | 批量应用失败后逐路径重试的并发数（≥ 1 整数） |
| `lockWaitMs` | `number` | `0` | `--lock-wait` | 等待其他同步释放仓库锁的毫秒数（≥ 0 整数）；`0` 表示被占用时立即报错退出 |
| `includeFileTypes` | `string[]` | `[]` | `--include-types` | 扩展名白名单，空表示不过滤；不带点的写法会补上点并转小写 |
| `ignorePatterns` | `string[]` | `[]` | `--ignore` | 追加忽略规则（gitignore 语法） |
| `retryConfig` | `RetryConfig` | 见下 | `--retry-*` | fetch 等网络类操作的重试 |
| `conflictResolutionConfig` | `ConflictResolutionConfig` | 见下 | `--conflict-strategy` | 冲突处理 |
| `fetchConfig` | `FetchConfig` | 见下 | `--fetch-filter` / `--fetch-depth` / `--fetch-tags` / `--lfs` | 从上游抓取多少内容，以及 Git LFS 文件写什么 |
| `logConfig` | `LogConfig?` | 未设置（只输出到控制台） | `--log-*` | 日志落盘与轮转 |
| `authConfig` | `AuthConfig?` | 未设置 | `--auth-*` | 上游访问凭据 |
| `branchStrategyConfig` | `BranchStrategyConfig` | `enable: false`，其余见下 | — | 在派生分支上同步 |
| `grayReleaseConfig` | `GrayReleaseConfig?` | 未设置 | `-gr` 等 | 灰度发布 |
| `webhookConfig` | `WebhookConfig?` | 未设置 | `-we` 等 | Webhook 守护模式 |
| `notifyConfig` | `NotifyConfig` | `enable: false`、`channels: []` | `--notify*` / `--no-notify` | 运行结束后的播报 |
| `prConfig` | `PrConfig?` | 未设置 | `--pr*` | PR 模式：改动进自动生成的分支，目标分支不动 |
| `fullRelease` | `boolean` | `false` | `-fr, --full-release` | 发布灰度剩余文件 |
| `rollback` | `boolean` | `false` | `-ro, --rollback` | 回滚记录中的灰度发布 |

`verbose` / `silent` / `dryRun` 等布尔字段在命令行层只在标志出现时才写入，因此配置文件里的 `true` 不会被"没写的命令行"重置为 `false`。

有些开关只有命令行形态，配置文件里没有对应键：`-uo, --undo`（撤销状态文件里记录的最后一次同步）、`--lang`（本次输出的语言）、`--json`、`--debug`、`--fetch`、`--limit`，以及 `status` / `why` / `doctor` / `history` / `init` / `completion` 这些动作。语言还可以用环境变量 `SYNC_UPSTREAM_LANG` 指定（详见[命令行参考](/reference/cli)）。

## upstreamRepo 允许的形态

| 形式 | 示例 |
|---|---|
| HTTPS / HTTP | `https://github.com/org/repo.git` |
| SSH URL | `ssh://git@github.com/org/repo.git` |
| git / file 协议 | `git://host/repo.git`、`file:///srv/repo` |
| scp 风格 | `git@github.com:org/repo.git`（内部会规范化为 `ssh://`） |
| 本地路径 | `/srv/repo`、`../vendor/repo`、`J:\vendor\repo` |

本地路径常用于测试与离线场景：上游可以是你磁盘上的另一个仓库。

`upstreamBranch` 不限于分支：标签名（`v1.8.0`）和提交号同样可用，此时同步的是那个版本的内容而不是分支的最新状态。按提交号抓取需要服务端允许（`uploadpack.allowAnySHA1InWant`）。

## 多上游 upstreams

一个目标分支同时跟几个上游时用这一节。每一项都描述"一个源"，四个字段都可省略，省略的字段继承顶层的 `upstreamRepo` / `upstreamBranch` / `syncDirs` / `commitMessage`。

```json
{
  "upstreamRepo": "https://github.com/org/base.git",
  "upstreamBranch": "main",
  "syncDirs": ["src/config"],
  "upstreams": [
    { "branch": "dev" },
    { "repo": "https://github.com/org/ui-kit.git", "branch": "release", "dirs": ["src/components"], "message": "Sync ui-kit release" }
  ]
}
```

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `repo` | `string` | 顶层 `upstreamRepo` | 这个源的仓库地址；顶层地址为空时必填 |
| `branch` | `string` | 顶层 `upstreamBranch` | 这个源的分支 / 标签 / 提交号 |
| `dirs` | `string[]` | 顶层 `syncDirs` | 这个源负责的同步目录，非空数组 |
| `message` | `string` | 顶层 `commitMessage` | 这个源那一次提交的消息 |

规则与后果：

- 一旦写了 `upstreams`，本次运行就只处理这个列表，**不再额外处理顶层那一条**。想同时跟顶层源和另一个源，就把顶层源也写成列表里的第一项。
- 每个源有独立的增量状态文件和独立的一次提交；抓取远程按**仓库**区分（同一仓库的多个 ref 共用一个远程，不同仓库各占一个）：第一个叫 `sync-upstream`，之后的依次是 `sync-upstream-2`、`sync-upstream-3`……
- 目录重叠时按配置顺序应用，后一个源的内容覆盖前一个；同一源写两次、目录重叠都会给出警告。
- 增量状态文件写在仓库根，名字形如 `.sync-state-<ref>-<8位哈希>.json`。内置忽略规则只精确匹配 `.sync-state.json` 这一个名字，所以建议在 `.gitignore` 里补一条 `.sync-state-*.json`。
- 多上游与灰度发布互斥：`-gr` / `-fr` / `-ro` 在多于一个源时会直接报错，需要灰度就一次只配一个源。

命令行上重复 `-r`（或 `-b`）就是这一节的简写：`-r A -r B` 等价于两个源、其余字段继承顶层。

## 删除与改名

| 字段 | 可选值 / 范围 | 默认值 | 说明 |
|---|---|---|---|
| `deletePolicy` | `mirror` / `keep` / `ask` | `mirror` | 上游已经删掉、目标分支还留着的那些文件怎么走 |
| `renameDetection` | 布尔 | `true` | 上游改名（内容基本没变的路径搬走）是否合成一次移动 |
| `renameThreshold` | 1–100 整数 | `60` | 改名配对的相似度下限，即 git `--find-renames` 的百分比 |

`deletePolicy` 三种取值的差别：

| 取值 | 行为 |
|---|---|
| `mirror` | 跟随上游删除，同步范围内的路径与上游逐字节一致（历次版本的行为） |
| `keep` | 保留本地文件，每条删除都记为一次跳过并报告出来 |
| `ask` | 一次运行问一次；`-y`、`--json` 或没有终端可答时按 `keep` 处理 |

命令行 `--delete-policy mirror|keep|ask`，另有简写 `--delete`（= `mirror`）与 `--no-delete`（= `keep`）；显式给出时覆盖配置文件。

`renameDetection` 为 `true` 时，改名在计划里是一条移动：旧路径删除、新路径写入，本地对该文件的改动与文件历史都能保留；为 `false` 时按"删除 + 新增"两项处理。相似度低于 `renameThreshold` 的删除/新增配对仍然按两个文件处理。

下面三种组合会**自动关闭改名**并给出警告，因为它们与改名无法共存：

- `deletePolicy: 'keep'`：改名同样会移除旧路径，与"不删本地文件"的承诺冲突，需要改名请改回 `mirror`
- 开启 `grayReleaseConfig`：改名只能整体应用，无法按批次放量，本次按删除 + 新增处理
- 设置 `fetchConfig.depth`：抓取窗口之外的旧版本取不到，配不成对

## retryConfig

```json
{ "retryConfig": { "maxRetries": 3, "initialDelay": 2000, "backoffFactor": 1.5 } }
```

| 字段 | 约束 | 含义 |
|---|---|---|
| `maxRetries` | ≥ 0 整数 | 首次之外的重试次数 |
| `initialDelay` | ≥ 0 | 首次等待毫秒数 |
| `backoffFactor` | ≥ 1 | 第 n 次等待 `initialDelay × factor^(n-1)` |

仅当错误信息命中"网络类"特征（`网络` / `network` / `connect` / `resolve host` / `timed out` / `timeout` / `reset` / `closed` / `RPC failed` / `early EOF` / `无法访问` / `不可达`）才重试；认证失败、路径非法这类问题立即抛出原错误。重试用尽后包装为 `TimeoutError`（信息含"超时 / timeout"）或 `NetworkError`。

对应命令行：`--retry-max`、`--retry-delay`、`--retry-backoff`（可分别覆盖，互不影响）。

## fetchConfig

决定向上游要多少内容。默认值就是历次版本的行为：完整抓取、不额外发起 LFS 请求。

```json
{ "fetchConfig": { "filter": "blob", "tags": false, "lfs": "pointer", "depth": 50 } }
```

| 字段 | 类型 | 默认值 | 命令行 | 说明 |
|---|---|---|---|---|
| `filter` | `none` / `blob` / `tree` | `none` | `--fetch-filter` | 部分抓取。`none` 取全部对象，也是唯一能离线读到上游文件内容的模式；`blob` 只取提交与目录树，文件内容用时再回源取，是"仍能算出计划"的最省选项；`tree` 只取提交，传输最小，但每次读文件都要联网，同步目录越宽越可能比 `none` 更慢（会给出警告） |
| `depth` | `number`（可选） | 未设置 | `--fetch-depth` | 只取最近 n 个提交（≥ 1 整数）。**副作用是整个本地仓库变浅**：别人的 `git log` 也一起变短，抓取窗口之外的历史读不到。未写下这一项时不限制深度 |
| `tags` | `boolean` | `false` | `--fetch-tags` / `--no-fetch-tags` | 抓取时是否一并带上上游标签；默认不带，免得一次普通分支抓取拖回上游整张标签表 |
| `lfs` | `pointer` / `materialize` / `off` | `pointer` | `--lfs` | 上游用 Git LFS 管理的文件往工作区写什么。`pointer` 只写指针文本（同源码文件一起演进时是对的，二进制资源则不可用）；`materialize` 写完指针后再向上游取回真实内容并替换，需要本机装了 `git-lfs` 且上游的 LFS 服务可用；`off` 完全不检测 |

需要注意的组合：

- `depth` 与改名识别不能共存，设置了 `depth` 会关闭改名并警告
- `lfs: 'materialize'` 配合 `filter: 'blob'` 或 `tree` 时省不下多少流量（要取真实内容就得把对象拉回来），会警告
- `filter` 与 `tags` 只影响抓取多少，增量跳过与改名配对在 `blob` 下照常工作

每次运行会报告本次遇到多少个 LFS 指针、回取了几个真实对象；本机没有 `git-lfs` 或上游 LFS 服务不可达时只给提示，不会让同步失败。

## conflictResolutionConfig

```json
{
  "conflictResolutionConfig": {
    "defaultStrategy": "prompt-user",
    "autoResolveTypes": [".md"],
    "logResolutions": true
  }
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `defaultStrategy` | `prompt-user` | `use-source` / `keep-target` / `auto-merge` / `prompt-user` / `skip` |
| `autoResolveTypes` | `[]` | 命中的扩展名在 `prompt-user` 下不提示，直接保留本地 |
| `logResolutions` | `true` | 逐条输出决策（`debug` 级别），含路径、类型、策略、动作与原因 |
| `resolutionLogFile` | 未设置 | 每条决策以 JSONL 追加到这个文件（相对路径按仓库根解析）；没有冲突时不产生文件 |

策略到动作的映射：`use-source → take-upstream`、`keep-target → keep-local`、`skip → skip`、`auto-merge →` 由三方合并结果决定（可能产生带冲突标记的 `write-merged`）。

冲突类型：检测目前会产出 `content`（内容冲突）、`delete-modify`（上游删除但本地有改动）、`untracked-overwrite`（需要覆盖未跟踪文件）、`type`（文件与目录互换）四类；`add-add`、`symlink`、`unreadable` 是类型里保留的取值，当前不会产生。

## authConfig

```json
{ "authConfig": { "type": "pat", "username": "git", "token": "..." } }
```

| `type` | 需要的字段 | 传输方式 |
|---|---|---|
| `ssh` | `privateKeyPath`（可选 `passphrase`） | 子进程环境 `GIT_SSH_COMMAND = ssh -i <key> -o IdentitiesOnly=yes -o BatchMode=yes` |
| `pat` | `token`（用户名固定 `git`） | 凭据写入远端 URL 的 userinfo 段 |
| `user_pass` | `username` + `password` | 同上 |

要点：

- 带口令的私钥不会被交互式索取口令（`BatchMode` 下 git 会直接失败），工具会提示先把钥匙交给 ssh-agent
- 任何日志与错误信息里的 `user:secret@host` 都会被替换为 `***`
- GitHub App 与 OIDC 未实现

## branchStrategyConfig

```json
{
  "branchStrategyConfig": {
    "enable": true,
    "strategy": "feature",
    "baseBranch": "company/main",
    "branchPattern": "feature/sync-{date}",
    "autoSwitchBack": true,
    "autoDeleteMergedBranches": false
  }
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enable` | `false` | 关闭时直接在 `companyBranch` 上工作 |
| `strategy` | `feature` | `feature` / `release` / `hotfix` / `develop`（小写） |
| `baseBranch` | `main` | 起点分支，必须存在，否则报错 |
| `branchPattern` | `feature/sync-{date}` | 支持 `{date}`（`YYYY-MM-DD`）、`{base}`、`{strategy}`；反斜杠归一为 `/`；其他花括号占位符按字面保留 |
| `autoSwitchBack` | `true` | 工作提交完成后切回运行前所在的分支；游离 HEAD 时不切。PR 模式总会切回，因为目标分支没有动 |
| `autoDeleteMergedBranches` | `false` | 打开后删除"本工具生成的、已合并进 `companyBranch` 的、当前没有签出的"同步分支。只认 `branchPattern` 里第一个 `{` 之前的前缀（如 `feature/sync-`），所以模式里没有占位符时不会删任何分支；目标分支与 `baseBranch` 永远不会被删；未合并的分支删不掉 |

预览模式不套用分支策略，也不会切换分支。

## grayReleaseConfig

```json
{
  "grayReleaseConfig": {
    "enable": true,
    "strategy": "percentage",
    "percentage": 20,
    "canaryDirs": ["packages/shared"],
    "filePatterns": ["*.json"],
    "validationScript": "pnpm typecheck",
    "maxRetries": 0,
    "rollbackOnFailure": false,
    "auditLogPath": ".sync-gray-audit.jsonl",
    "enableMonitoring": false,
    "monitorInterval": 5000,
    "alertThresholds": { "errorRate": 0.1, "performanceDrop": 30, "maxExecutionTime": 120000 }
  }
}
```

| 字段 | 说明 |
|---|---|
| `enable` | 必填 `true` 才创建灰度控制器 |
| `strategy` | `percentage` / `directory` / `file`（小写） |
| `percentage` | `(0, 100]`；对路径做确定性分桶，同一计划重跑选到同一批 |
| `canaryDirs` | `directory` 策略必需非空，匹配变更所属的同步目录 |
| `filePatterns` | `file` 策略必需非空；`*.ext` 按后缀、含 `/` 的按路径后缀、其余按文件名精确匹配 |
| `validationScript` | 在仓库根执行的命令，非 0 退出视为校验失败 |
| `maxRetries` | 校验重试次数（`?? 0`，即默认不重试） |
| `rollbackOnFailure` | 校验失败时是否自动回滚，默认 `false` |
| `auditLogPath` | 相对仓库根的 JSONL 路径，默认 `.sync-gray-audit.jsonl` |
| `enableMonitoring` / `monitorInterval` / `alertThresholds` | 采样失败率、耗时并输出告警，仅日志 |

阶段：`idle` → `canary` → `validating` → `completed` / `failed` / `rolled-back`。
选中集合为空、`percentage` 缺失或越界、`directory`/`file` 策略缺参数都会直接报错（`percentage` 走 CLI 时默认 20，配置文件里则必须显式给出）。

两个组合限制：多上游 fan-in（`upstreams`）与灰度互斥，`-gr` / `-fr` / `-ro` 在多于一个源时直接报错；灰度开启期间改名识别会被关掉并警告，改名按删除 + 新增处理。

## webhookConfig

```json
{
  "webhookConfig": {
    "enable": true,
    "host": "127.0.0.1",
    "port": 3000,
    "path": "/webhook",
    "secret": "…",
    "allowedEvents": ["push"],
    "triggerBranch": "main",
    "supportedPlatforms": ["github"],
    "healthPath": "/healthz",
    "deduplicate": true,
    "deliveryLog": ".sync-webhook-deliveries.jsonl",
    "maxQueue": 8,
    "maxBodyBytes": 1048576,
    "retryConfig": { "maxRetries": 2, "initialDelay": 1000, "backoffFactor": 2 },
    "securityConfig": {
      "ipWhitelist": ["127.0.0.1", "10.0.0.0/8"],
      "rateLimit": { "maxRequestsPerSecond": 5, "statusCode": 429, "message": "请求过于频繁" }
    },
    "eventFilterConfig": {
      "rules": [
        { "eventType": "push", "conditions": [{ "fieldPath": "ref", "operator": "eq", "value": "refs/heads/main" }] }
      ]
    }
  }
}
```

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enable` | `boolean` | 必填 | 为真时以守护模式常驻，不执行一次性同步 |
| `host` | `string` | `127.0.0.1` | 绑定地址；要对整台机器以外提供服务需显式写 `0.0.0.0`。对外监听又没配 TLS 或白名单时 `doctor` 会警告 |
| `port` | `number` | 必填 | 0–65535；填 `0` 由系统分配并在日志里打印实际端口 |
| `path` | `string` | 必填 | 必须以 `/` 开头，仅接受 POST |
| `secret` | `string` | 必填非空 | 空值在配置校验阶段就被拒绝（`启用 webhook 时 webhookConfig.secret 不能为空`，退出码 2）；以库方式绕过校验起服务时任何请求都回 `401`，见 [Webhook 守护模式](/guide/webhook#请求处理的顺序) |
| `allowedEvents` | `string[]` | — | 事件白名单，粗筛第一步 |
| `triggerBranch` | `string` | — | 只有该分支的事件才触发（比较的是去掉 `refs/heads/` 后的短名） |
| `supportedPlatforms` | 平台数组 | — | `github` / `gitlab` / `bitbucket` / `gitea`；只有一个平台时允许缺少平台标识头 |
| `tlsCert` / `tlsKey` | `string` | 未设置 | 证书与私钥**文件路径**（相对当前目录解析），必须成对给出；成对时用 HTTPS 提供服务 |
| `trustProxy` | `boolean` | `false` | 只有确实位于可信反向代理之后才开启；开启后 `x-forwarded-for` 的首跳才参与 IP 白名单与限流判断 |
| `maxBodyBytes` | `number` | `1048576`（1 MiB） | 请求体上限（不小于 1024 的整数），超限返回 413 并断开连接 |
| `healthPath` | `string` / `false` | `/healthz` | GET/HEAD 这个路径做存活探针，返回是否在退出中、在跑的同步数、队列上限、各类投递计数与最近一次投递；`false` 关闭 |
| `deduplicate` | `boolean` | `true` | 已经处理过的投递 id（平台的重发）不再触发第二次同步，直接回 200 并说明原因 |
| `deliveryLog` | `string` | 未设置 | 每收到一次投递追加一行 JSONL 审计；相对路径按当前目录解析。未设置时给一条警告——进程退出后投递决定就无从回看 |
| `seenStateFile` | `string` | `<deliveryLog>.seen.json` | 跨重启记住"已处理过的投递 id"的文件；没配 `deliveryLog` 也没配这一项时只在内存里去重 |
| `seenHistory` | `number` | `512` | 上面那个文件保留多少个 id（大于 0 的整数），超出后丢最旧的 |
| `maxQueue` | `number` | `8` | 最多允许几个同步排队等仓库锁（1–1000 整数）；排满后新投递回 503，让平台稍后重投而不是默默等一个没有结果的 202 |
| `securityConfig.ipWhitelist` | `string[]` | 未设置（不限制） | 支持精确 IP 与 CIDR；空列表表示不限制 |
| `securityConfig.rateLimit` | 对象 | 未设置（关闭） | 令牌桶，按客户端 IP 计数；`maxRequestsPerSecond ≤ 0` 表示关闭 |
| `eventFilterConfig.rules` | 数组 | 未设置 | 逐事件的精细条件；某事件一旦有规则就必须至少命中一条 |
| 条件运算符 | — | — | `eq` / `ne` / `gt` / `lt` / `contains` / `regex`；`fieldPath` 是点分路径，只做属性遍历不执行代码 |

签名方案：GitHub/Gitea `x-hub-signature-256`（`sha256=<hmac>`），Bitbucket `x-hub-signature`（同样要求 `sha256=`），GitLab `x-gitlab-token` 明文比对。全部走恒定时间比较，失败原因不含密钥内容。

投递审计只记形状（时间、平台、事件、分支、决定、原因、状态码、耗时、归一化后的客户端地址），不记请求体本身——推送事件里带着提交消息和作者邮箱。`--webhook-log <路径>` 写 `deliveryLog`，`--webhook-queue <n>` 写 `maxQueue`，`--webhook-host` 写 `host`，其余字段只能写在配置文件里。

## logConfig

把日志同时写进一个会轮转的文件。**不写这一节时只输出到控制台**，这正是一次性同步想要的行为；守护进程和会跑很久的 CI 才需要落盘。

```json
{
  "logConfig": {
    "file": "logs/sync-upstream.log",
    "level": "info",
    "json": false,
    "maxBytes": 5242880,
    "keep": 5
  }
}
```

| 字段 | 类型 | 默认值 | 命令行 | 说明 |
|---|---|---|---|---|
| `file` | `string` | 未设置（不落盘） | `--log-file` | 日志同时追加到这个文件；相对路径按当前工作目录解析，目录不存在会创建 |
| `level` | `debug` / `info` / `warn` / `error` | `info` | `--log-level` | 进入文件的最低级别。控制台上的 `verbose`、`success` 等级别写进文件时会归到最接近的这四档 |
| `json` | `boolean` | `false` | `--log-json` / `--no-log-json` | 每行一个 JSON 对象（`at`、`level`、`message`，有上下文时加 `context`），代替 `[时间] [级别] 文本` 格式 |
| `maxBytes` | `number` | `5242880`（5 MiB） | `--log-max` | 超过这个字节数就轮转（不小于 1024 的整数） |
| `keep` | `number` | `5` | `--log-keep` | 保留几份轮转文件（0–100），`<file>.1` 是最新的一份；`0` 表示不留历史，直接清空重来 |
| `redact` | `string[]` | `[]` | — | 除自动打码之外还要从文件里抹掉的原文，每项必须是非空字符串 |

写进文件之前会去掉颜色码，并把 URL 里的账号口令、`token=` / `secret=` / `Bearer …` 这类值打码；webhook 的 `secret` 与凭据类配置也会自动加入打码名单。控制台与文件各管各的：`verbose` / `silent` 只影响控制台。轮转与写入失败只会往控制台报一句，不会中断同步。

## notifyConfig

运行结束之后把结果播出去：控制台、通用 HTTP、Slack、钉钉、企业微信。

```json
{
  "notifyConfig": {
    "enable": true,
    "channels": ["stdout", "slack", "dingtalk"],
    "slackUrl": "https://hooks.slack.com/services/…",
    "dingtalkUrl": "https://oapi.dingtalk.com/robot/send?access_token=…",
    "dingtalkSecret": "SEC…",
    "events": ["success", "conflict", "failure", "undo"],
    "timeoutMs": 5000,
    "retries": 2,
    "template": "sync-upstream {outcome}：{upstreamBranch} → {companyBranch}，{files} 个文件，冲突 {conflicts}"
  }
}
```

| 字段 | 类型 | 默认值 | 命令行 | 说明 |
|---|---|---|---|---|
| `enable` | `boolean` | `false` | `--notify` 置真、`--no-notify` 置假 | 总开关 |
| `channels` | `stdout` / `http` / `slack` / `dingtalk` / `wecom` 的数组 | `[]` | `--notify <a,b>` | 启用时不能为空；缺少对应地址的渠道会被跳过并说明原因，不算错误 |
| `url` | `string` | 未设置 | `--notify-url` | 通用 HTTP 渠道：每个事件一次 JSON POST，必须是 http(s) |
| `headers` | `object` | 未设置 | — | 附加请求头，例如 `{ "authorization": "Bearer …" }` |
| `slackUrl` / `dingtalkUrl` / `wecomUrl` | `string` | 未设置 | — | 各平台机器人地址，必须是 http(s) |
| `dingtalkSecret` | `string` | 未设置 | — | 钉钉机器人的"加签"密钥，没有它投递会被平台拒 |
| `events` | `success` / `noop` / `conflict` / `failure` / `undo` 的数组 | 除 `noop` 外全部 | `--notify-events` | 哪些结果才播报。`noop` 是计划为空的运行，默认不播——繁忙仓库上的守护进程不该每条推送都发一条消息 |
| `timeoutMs` | `number` | `5000` | — | 单次请求上限（不小于 500 的整数）；端点挂了也不会把命令挂住 |
| `retries` | `number` | `2` | — | 每个渠道的尝试次数（1–5，含首次） |
| `template` | `string` | 未设置 | — | 自定义文案；未写时用默认的多行摘要。占位符：`{outcome}` `{upstream}` `{upstreamBranch}` `{companyBranch}` `{commit}` `{files}` `{kept}` `{conflicts}` `{skipped}` `{error}` `{duration}` `{dirs}` `{prBranch}` `{prUrl}`；认不出的占位符原样保留 |
| `includeDetails` | `boolean` | `true` | — | 默认文案里是否附上示例文件路径（最多几条，不是全量清单） |
| `retryConfig` | `RetryConfig` | 未设置 | — | 只用到重试间隔，缺省 500ms |

地址与密钥请写在配置文件里而不是命令行——同一台机器上的其他进程能读到命令参数。播报内容里的上游地址一律脱敏；PR 模式下目标分支没动，消息里会带上分支名与评审入口，免得播报一件没人能合并的事。

## prConfig

GitOps 用法：改动不落到目标分支，而是提交到一个自动生成的分支、推送上去，交给你审的是一条 PR。

```json
{
  "prConfig": {
    "enable": true,
    "branchPattern": "sync-upstream/{target}-{date}",
    "remote": "origin",
    "title": "Sync upstream main",
    "body": "自动同步，评审后合并。",
    "draft": true,
    "create": "auto"
  }
}
```

| 字段 | 类型 | 默认值 | 命令行 | 说明 |
|---|---|---|---|---|
| `enable` | `boolean` | `false` | `--pr` / `--no-pr` | 总开关 |
| `branchPattern` | `string` | `sync-upstream/{target}-{date}` | `--pr-branch` | `{target}` 是目标分支名，`{date}` 是 `yyyymmdd`；算出来的名字已存在时自动追加 `-2`、`-3`，不会复用旧分支 |
| `remote` | `string` | 目标分支跟踪的上游，没有则 `origin` | `--pr-remote` | 分支推到哪个远程；一个远程都没有时直接报错 |
| `title` | `string` | 未设置（用自动生成的标题） | `--pr-title` | PR 标题 |
| `body` | `string` | 未设置 | `--pr-body` | 追加在自动生成描述后面的说明 |
| `draft` | `boolean` | `false` | `--pr-draft` | 以草稿 PR 创建 |
| `create` | `auto` / `never` | `auto` | `--pr-no-create`（= `never`） | `auto` 在本机装了 `gh` / `glab` 时真的开 PR；`never` 只推分支并给出对比链接 |
| `tool` | `gh` / `glab` | 按远程主机自动选择 | — | 显式指定用哪个命令行工具 |

要点：

- 没装对应的命令行工具时照样推送分支并打印对比链接；开 PR 这件事永远不会让同步失败
- 与预览（`-P` / `-n`）、`branchStrategyConfig`、`grayReleaseConfig` 互斥，同时给出会报校验错误
- 目标分支不被推送：`autoPush` 会被关掉并警告
- PR 模式的运行不读也不写增量状态——改动还没进目标分支，记了会让下次同步误判"已经同步过"

## 运行产物与清理

工具在你仓库里留下的东西：

| 产物 | 什么时候出现 | 作用 | 什么时候需要管它 |
|---|---|---|---|
| `sync-upstream.config.json`（或 `-F` / `-C` 指定的格式与路径） | 只在 `--generate-config` 或 `init` 之后 | 配置模板或问答生成的配置，之后每次运行都会读它 | 由你自己保管、提交与编辑；工具不会改写它，不想要就删 |
| `.sync-state.json`（仓库根） | 每次真实同步之后 | 增量同步的基线：每个已同步路径对应的上游内容哈希、权限位与时间，外加最近 50 次同步的记录 | 换上游仓库、上游分支或目标分支时会自动作废重建，不需要手工清理；删掉最多多做一次全量比对。`--undo` 与 `history` 完全依赖其中的同步记录，删了就撤销不了 |
| `.sync-state-<ref>-<哈希8位>.json`（仓库根） | 配了 `upstreams` 时，每个上游一份 | 同上，各上游各一份，避免互相把对方的工作标成"已同步" | 同上；名字随上游地址与 ref 变化，建议在 `.gitignore` 里用 `.sync-state-*.json` 一条覆盖 |
| `.sync-gray.json`（仓库根） | 灰度发布期间 | 灰度进度：哪些文件已发、哪些待发、回滚点在哪 | 灰度进行中**不要删**，`--full-release` 与 `--rollback` 完全依赖它；全量发布成功后会自动删除 |
| `.sync-gray-audit.jsonl`（仓库根） | 灰度发布期间 | 灰度阶段的追加式审计流水 | 纯记录，删掉不影响同步与回滚；路径可用 `grayReleaseConfig.auditLogPath` 改 |
| `.git/sync-upstream.lock` | 同步、撤销、灰度进行期间 | 仓库锁：同一工作目录里两个同步会互相踩对方的 `checkout`、索引与提交 | 正常运行结束自动删除。进程被强杀后残留时：持有者已退出会被立即接管，超过 30 分钟也会自动接管；`doctor` 会报出持有者与创建时间，也可手工删除 |
| `<webhookConfig.deliveryLog>` 指向的文件 | 只在配了 `deliveryLog` 的守护模式 | 每收到一次投递追加一行 JSONL：平台、事件、分支、决定、原因、应答状态码、耗时 | 纯记录，可以随时删或轮转；不含请求体，也不含密钥 |
| `<deliveryLog>.seen.json`（或 `seenStateFile` 指定的名字） | 只在配了投递审计或显式指定该路径时 | 跨重启记住"处理过哪些投递 id"，防止平台重发触发第二次同步 | 删掉的后果只是丢掉去重记忆；文件只保留最近 `seenHistory` 个 id |
| `logConfig.file` 与 `<file>.1` … `<file>.<keep>` | 只在配了 `logConfig.file` 时 | 落盘日志与轮转历史，写入前已去色并打码 | 自行决定保留多久；`keep: 0` 时不留历史 |
| remote `sync-upstream`（多上游时还有 `sync-upstream-2`、`-3` …） | 每次运行自动校正 | `.git/config` 里的上游仓库记录 | 可以随时 `git remote remove sync-upstream`，下次运行会重新添加 |
| PR 模式下自动生成的分支 | 只在 `prConfig.enable` 时 | 承载本次改动、等评审合并 | 由你自己处置；合并或关掉之后可以删 |

使用 `pat` / `user_pass` 认证时，这些 remote 的 URL 会带上凭据。因此**不要把 `.git/config` 提交或贴进日志、issue**；用 SSH 或凭据助手则 URL 里不含密钥。日志与报错里的 URL 一律已脱敏。

状态文件与灰度文件都不该提交进版本库，建议写进项目的 `.gitignore`：

```text
.sync-state.json
.sync-state-*.json
.sync-gray.json
.sync-gray-audit.jsonl
```

### 哪些是工具自己生成的文件

内置忽略规则会保证下面这些路径永远不进入同步计划：`.git/`、`node_modules/`、`.DS_Store`、`.sync-state.json`，以及旧版本遗留的 `.sync-cache/`、`.sync-temp/`、`.sync-hashes.json`（当前版本既不读也不写，可以直接删）。

不在忽略清单里的：**`.sync-gray.json`、`.sync-gray-audit.jsonl`、多上游的 `.sync-state-*.json`**，以及 `dist/` 与 `build/`（它们可能是需要同步的真实产物）。所以如果你把仓库根 `.` 当作同步目录，而上游恰好有同名文件，本地灰度记录会被上游版本覆盖。把同步范围限制在真实源码目录，或把这几个名字写进 `.syncignore` 即可避开。

忽略规则的叠加顺序（内置 → 根 `.gitignore` → `.syncignore` → 配置项 → 同步目录内嵌套 `.gitignore`，后者优先）见[配置指南](/guide/configuration)。

## 已移除的键与新增别名

下面三个键已经不存在。写出来不会再有任何效果，但也不会静默失效——运行时会给出一次"已废弃并被忽略"的警告，并说明现在用什么做判定：

| 键 | 现在靠什么 |
|---|---|
| `cache` | 增量判定直接用 git 记录的内容哈希，状态文件本身就是判定依据，没有单独的缓存层 |
| `cacheConfig` | 同上 |
| `adaptiveConcurrency` | 并发数固定由 `concurrencyLimit` 控制，没有自适应调节 |

本页新写到的字段也有历史拼法，会自动改写并给出一次警告（完整清单见[配置指南的别名小节](/guide/configuration#别名与废弃键)）：

| 你写的 | 实际生效 |
|---|---|
| `deletions` | `deletePolicy` |
| `renames`、`findRenames` | `renameDetection` |
| `fetch`、`clone` | `fetchConfig` 整节 |
| `partialClone`、`cloneFilter` | `fetchConfig.filter` |
| `fetchDepth` | `fetchConfig.depth` |
| `fetchTags` | `fetchConfig.tags` |
| `lfs`、`lfsMode` | `fetchConfig.lfs` |
| `log`、`logging` | `logConfig` 整节 |
| `logFile` | `logConfig.file` |
| `logLevel` | `logConfig.level` |
| `logJson` | `logConfig.json` |
| `logMaxBytes`、`logRotate` | `logConfig.maxBytes` |
| `logKeep` | `logConfig.keep` |
| `pr`、`pullRequest` | `prConfig` 整节 |
| `notify`、`notifications` | `notifyConfig` 整节 |
| `webhookLog` | `webhookConfig.deliveryLog` |
| `webhookQueue` | `webhookConfig.maxQueue` |

别名写法类型不对（例如 `maxRetries: "abc"`）是硬错误，会直接终止；拼写正确的规范键永远不会被报成"未识别的配置项"。

## 相关页面

- [配置指南](/guide/configuration)：分层、发现顺序、别名、忽略规则叠加
- [命令行参考](/reference/cli)：每个字段对应的参数与默认值
- [使用总览](/guide/usage)：各专项页面的入口（同步、冲突、灰度、Webhook、CI）
- [API 参考](/reference/api)：编程入口与类型
