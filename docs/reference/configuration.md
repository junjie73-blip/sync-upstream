# 配置参考

本页逐项列出 `SyncConfig` 的规范字段。配置文件、命令行、编程 API 用的是**同一套键名**；历史别名见 [配置指南的别名小节](/guide/configuration#别名与废弃键)。

类型定义在 `src/domain/`，可从包直接导入：

```ts
import type { GrayReleaseConfig, SyncConfig, WebhookConfig } from 'sync-upstream'
```

## 顶层字段

| 字段 | 类型 | 默认值 | 命令行 | 说明 |
|---|---|---|---|---|
| `upstreamRepo` | `string` | `''`（必填） | `-r, --repo` | 上游仓库地址 |
| `upstreamBranch` | `string` | `'main'` | `-b, --branch` | 上游分支 |
| `companyBranch` | `string` | `'main'` | `-c, --company-branch` | 目标分支（本地/`origin` 必须已存在） |
| `syncDirs` | `string[]` | `[]`（必填非空） | `-d, --dirs` | 同步范围，仓库根相对路径 |
| `commitMessage` | `string` | `'Sync upstream changes to specified directories'` | `-m, --message` | 提交消息 |
| `autoPush` | `boolean` | `false` | `-p, --push` | 提交后推送；`dryRun` 为真时被强制关闭并警告 |
| `forceOverwrite` | `boolean` | `true` | `-f, --force` / `--incremental` | `true` 应用全部计划；`false` 依据 `.sync-state.json` 增量 |
| `verbose` | `boolean` | `false` | `-V, --verbose` | 提升日志等级并输出完整变更清单 |
| `silent` | `boolean` | `false` | `-s, --silent` | 只输出错误 |
| `dryRun` | `boolean` | `false` | `-n, --dry-run` | 试运行，等价于 `previewOnly` |
| `previewOnly` | `boolean` | `false` | `-P, --preview-only` | 只打印计划 |
| `nonInteractive` | `boolean` | `false` | `-y, --non-interactive` | 不提问；`prompt-user` 降级为 `keep-target` |
| `concurrencyLimit` | `number` | `10` | `--concurrency` | 批量应用失败后逐路径重试的并发数 |
| `includeFileTypes` | `string[]` | `[]` | `--include-types` | 扩展名白名单，空表示不过滤 |
| `ignorePatterns` | `string[]` | `[]` | `--ignore` | 追加忽略规则（gitignore 语法） |
| `retryConfig` | `RetryConfig` | 见下 | `--retry-*` | fetch 等网络类操作的重试 |
| `conflictResolutionConfig` | `ConflictResolutionConfig` | 见下 | `--conflict-strategy` | 冲突处理 |
| `authConfig` | `AuthConfig?` | 未设置 | `--auth-*` | 上游访问凭据 |
| `branchStrategyConfig` | `BranchStrategyConfig?` | 未设置（`-g` 生成的默认里 `enable: false`） | — | 在派生分支上同步 |
| `grayReleaseConfig` | `GrayReleaseConfig?` | 未设置 | `-gr` 等 | 灰度发布 |
| `webhookConfig` | `WebhookConfig?` | 未设置 | `-we` 等 | Webhook 守护模式 |
| `fullRelease` | `boolean` | `false` | `-fr, --full-release` | 发布灰度剩余文件 |
| `rollback` | `boolean` | `false` | `-ro, --rollback` | 回滚记录中的灰度发布 |

`verbose` / `silent` / `dryRun` 等布尔字段在命令行层只在标志出现时才写入，因此配置文件里的 `true` 不会被"没写的命令行"重置为 `false`。

## upstreamRepo 允许的形态

| 形式 | 示例 |
|---|---|
| HTTPS / HTTP | `https://github.com/org/repo.git` |
| SSH URL | `ssh://git@github.com/org/repo.git` |
| git / file 协议 | `git://host/repo.git`、`file:///srv/repo` |
| scp 风格 | `git@github.com:org/repo.git`（内部会规范化为 `ssh://`） |
| 本地路径 | `/srv/repo`、`../vendor/repo`、`J:\vendor\repo` |

本地路径常用于测试与离线场景：上游可以是你磁盘上的另一个仓库。

## retryConfig

```json
{ "retryConfig": { "maxRetries": 3, "initialDelay": 2000, "backoffFactor": 1.5 } }
```

| 字段 | 约束 | 含义 |
|---|---|---|
| `maxRetries` | ≥ 0 整数 | 首次之外的重试次数 |
| `initialDelay` | ≥ 0 | 首次等待毫秒数 |
| `backoffFactor` | ≥ 1 | 第 n 次等待 `initialDelay × factor^(n-1)` |

仅当错误信息命中"网络类"特征（`网络` / `network` / `connect` / `resolve host` / `timed out` / `RPC failed` / `early EOF` / `无法访问` / `不可达` 等）才重试；认证失败、路径非法这类问题立即抛出原错误。重试用尽后包装为 `TimeoutError` 或 `NetworkError`。

对应命令行：`--retry-max`、`--retry-delay`、`--retry-backoff`（可分别覆盖，互不影响）。

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
| `resolutionLogFile` | 未设置 | 类型里已声明，**当前实现未使用**，决策不落独立文件 |

策略到动作的映射：`use-source → take-upstream`、`keep-target → keep-local`、`skip → skip`、`auto-merge →` 由三方合并结果决定（可能产生带冲突标记的 `write-merged`）。

冲突类型（`ConflictType`）：`content`、`type`、`delete-modify`、`add-add`、`symlink`、`untracked-overwrite`、`unreadable`。

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
| `autoSwitchBack` | `true` | 类型里已声明，**当前实现未读取**：工作分支上的改动不会被自动切回，直接在该分支提交便于评审 |
| `autoDeleteMergedBranches` | `false` | 类型里已声明，**当前实现未读取**：工具不会自动删除任何分支 |

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

## webhookConfig

```json
{
  "webhookConfig": {
    "enable": true,
    "port": 3000,
    "path": "/webhook",
    "secret": "…",
    "allowedEvents": ["push"],
    "triggerBranch": "main",
    "supportedPlatforms": ["github"],
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

| 字段 | 说明 |
|---|---|
| `enable` | 为真时以守护模式常驻，不执行一次性同步 |
| `port` | 1–65535；填 `0` 由系统分配并在日志里打印实际端口 |
| `path` | 必须以 `/` 开头，仅接受 POST |
| `secret` | 必填非空；为空时所有请求 401 |
| `allowedEvents` | 事件白名单，粗筛第一步 |
| `triggerBranch` | 只有该分支的事件才触发（比较的是去掉 `refs/heads/` 后的短名） |
| `supportedPlatforms` | `github` / `gitlab` / `bitbucket` / `gitea`；只有一个平台时允许缺少平台标识头 |
| `securityConfig.ipWhitelist` | 支持精确 IP 与 CIDR；空列表表示不限制 |
| `securityConfig.rateLimit` | 令牌桶，按客户端 IP 计数；`maxRequestsPerSecond ≤ 0` 表示关闭 |
| `eventFilterConfig.rules` | 逐事件的精细条件；某事件一旦有规则就必须至少命中一条 |
| 条件运算符 | `eq` / `ne` / `gt` / `lt` / `contains` / `regex`；`fieldPath` 是点分路径，只做属性遍历不执行代码 |

签名方案：GitHub/Gitea `x-hub-signature-256`（`sha256=<hmac>`），Bitbucket `x-hub-signature`（同样要求 `sha256=`），GitLab `x-gitlab-token` 明文比对。全部走恒定时间比较，失败原因不含密钥内容。

请求体上限 1 MiB，超限返回 413 并断开连接。

## 运行产物与清理

工具在你仓库里留下的东西一共四样：

| 产物 | 作用 | 什么时候需要管它 |
|---|---|---|
| `.sync-state.json` | 增量同步的基线：记录每个已同步路径对应的上游内容与时间 | 换上游仓库或分支时会自动作废重建，不需要手工清理；删掉最多多做一次全量比对 |
| `.sync-gray.json` | 灰度发布的进度：哪些文件已发、哪些待发、回滚点在哪 | 灰度进行中**不要删**，`--full-release` 与 `--rollback` 完全依赖它；全量发布成功后会自动删除 |
| `.sync-gray-audit.jsonl` | 灰度阶段的追加式审计流水 | 纯记录，删掉不影响同步与回滚；路径可用 `grayReleaseConfig.auditLogPath` 改 |
| remote `sync-upstream` | `.git/config` 里的一条远程仓库记录，每次运行自动校正 | 可以随时 `git remote remove sync-upstream`，下次运行会重新添加 |

使用 `pat` / `user_pass` 认证时，这条 remote 的 URL 会带上凭据。因此**不要把 `.git/config` 提交或贴进日志、issue**；用 SSH 或凭据助手则 URL 里不含密钥。日志与报错里的 URL 一律已脱敏。

`.sync-state.json` 与 `.sync-gray.json` 都不该提交进版本库，建议写进项目的 `.gitignore`。

### 哪些是工具自己生成的文件

内置忽略规则会保证下面这些路径永远不进入同步计划：`.git/`、`node_modules/`、`.sync-state.json`，以及旧版本遗留的 `.sync-cache/`、`.sync-temp/`、`.sync-hashes.json`（当前版本既不读也不写，可以直接删）。

两个例外：**`.sync-gray.json` 与 `.sync-gray-audit.jsonl` 不在忽略清单里**，`dist/` 与 `build/` 也不在（它们可能是需要同步的真实产物）。所以如果你把仓库根 `.` 当作同步目录，而上游恰好有同名文件，本地灰度记录会被上游版本覆盖。把同步范围限制在真实源码目录，或把这几个名字写进 `.syncignore` 即可避开。

忽略规则的叠加顺序（内置 → 根 `.gitignore` → `.syncignore` → 配置项 → 同步目录内嵌套 `.gitignore`，后者优先）见[配置指南](/guide/configuration)。

## 相关页面

- [配置指南](/guide/configuration)：分层、发现顺序、别名、忽略规则叠加
- [命令行参考](/reference/cli)：每个字段对应的参数与默认值
- [使用总览](/guide/usage)：各专项页面的入口（同步、冲突、灰度、Webhook、CI）
- [API 参考](/reference/api)：编程入口与类型
