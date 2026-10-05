# 配置指南

一次运行的配置来自三层，后一层覆盖前一层：

```
默认值（src/config/defaults.ts）  <  配置文件  <  命令行参数
```

嵌套对象按字段合并，所以 `--retry-delay 5000` 只会改延迟，不会把配置文件里 `retryConfig.maxRetries` 抹掉。数组与标量整体替换。

## 配置文件从哪里来

显式指定优先：

```bash
sync-upstream -C config/sync.json
```

`-C` 指定的文件**读不到就终止**，不会退回默认值——路径写错、没有读权限、语法坏掉、内容为空、顶层不是对象，各是不同的报错，且解析失败时会把 JSON / YAML / TOML 每种格式的失败原因一起列出。

不带 `-C` 时，在当前目录按下列顺序查找第一个存在的文件：

```
sync-upstream.config.json   sync-upstream.config.json5
sync-upstream.config.yaml   sync-upstream.config.yml
sync-upstream.config.toml
sync-upstream.json          sync-upstream.json5
sync-upstream.yaml          sync-upstream.yml
sync-upstream.toml
.sync-toolrc.json5          .sync-toolrc.json
.sync-toolrc.yaml           .sync-toolrc.yml
.sync-toolrc.toml           .sync-toolrc
```

一个都没找到时使用默认值，并打印一条明确说明查找过哪些文件名的警告。

格式由扩展名决定；无扩展名的 `.sync-toolrc` 依次按 JSON → YAML → TOML 尝试。

## 生成一份起点

```bash
sync-upstream -g                       # 写出 sync-upstream.config.json
sync-upstream -g -F yaml               # 写出 sync-upstream.config.yaml
sync-upstream -g -C config/sync.toml -F toml
```

生成的是完整默认值，把不需要的字段删掉即可。

## 最小可用配置

必须由你给的只有两项：`upstreamRepo` 和 `syncDirs`。两个分支字段都有默认值 `main`，但跨团队协作时建议显式写出来：

```json
{
  "upstreamRepo": "https://github.com/vuejs/core.git",
  "upstreamBranch": "main",
  "companyBranch": "company/main",
  "syncDirs": ["packages/shared"]
}
```

`syncDirs` 必须是**非空字符串数组**，且每一项都是相对仓库根的路径：不能以 `/` 开头、不能是绝对路径、不能包含 `..`、不能有连续分隔符。匹配按整段路径进行：目录命中它下面的全部内容，**条目也可以直接写单个文件的路径**（例如 `["package.json"]`）。

## YAML 写法

```yaml
upstreamRepo: https://github.com/vuejs/core.git
upstreamBranch: main
companyBranch: company/main
syncDirs:
  - packages/runtime-core
  - packages/shared
ignorePatterns:
  - '**/__tests__/**'
  - '*.snap'
includeFileTypes: [.ts, .md]
concurrencyLimit: 10
forceOverwrite: true
autoPush: false
retryConfig:
  maxRetries: 3
  initialDelay: 2000
  backoffFactor: 1.5
conflictResolutionConfig:
  defaultStrategy: auto-merge
  autoResolveTypes: [.md]
  logResolutions: true
```

## TOML 写法

```toml
upstreamRepo = "https://github.com/vuejs/core.git"
upstreamBranch = "main"
companyBranch = "company/main"
syncDirs = [
  "packages/runtime-core",
  "packages/shared"
]
concurrencyLimit = 10

[retryConfig]
maxRetries = 3
initialDelay = 2000
backoffFactor = 1.5

[conflictResolutionConfig]
defaultStrategy = "prompt-user"
logResolutions = true
```

## 校验规则

配置层合并后统一校验，**所有问题一次报完**，不会改一个报一个。会检查的项：

| 字段 | 规则 |
|---|---|
| `upstreamRepo` | 非空，且是可识别的仓库地址：`https://`、`http://`、`ssh://`、`git://`、`file://`、scp 形式 `git@host:org/repo.git`，或本地路径（绝对 / `./` / `../` / Windows 盘符） |
| `upstreamBranch` / `companyBranch` | 非空 |
| `syncDirs` | 非空数组，逐项做路径合法性检查 |
| `concurrencyLimit` | ≥ 1 的整数 |
| `retryConfig.maxRetries` | ≥ 0 的整数 |
| `retryConfig.initialDelay` | ≥ 0 |
| `retryConfig.backoffFactor` | ≥ 1 |
| `conflictResolutionConfig.defaultStrategy` | `use-source` / `keep-target` / `auto-merge` / `prompt-user` / `skip` 之一（小写连字符） |
| `branchStrategyConfig` | 启用时 `strategy` ∈ `feature` / `release` / `hotfix` / `develop`，且 `baseBranch`、`branchPattern` 非空 |
| `grayReleaseConfig` | `strategy = percentage` 时 `percentage` ∈ `(0, 100]` |
| `webhookConfig` | 启用时 `port` 为 1–65535 的整数、`path` 以 `/` 开头、`secret` 非空 |

校验失败属于退出码 2。另外有一条会自动修正并警告：`dryRun` 与 `autoPush` 同时为真时，会关掉 `autoPush`（试运行不该推送）。

## 别名与废弃键

历史写法会自动改写并给出警告，例如：

| 你写的 | 实际生效 |
|---|---|
| `repo` / `upstreamUrl` / `upstream` | `upstreamRepo` |
| `branch` / `upstreamRef` | `upstreamBranch` |
| `targetBranch` / `downstreamBranch` / `baseBranch` | `companyBranch` |
| `dirs` / `syncDirectories` / `directories` | `syncDirs` |
| `message` | `commitMessage` |
| `push` | `autoPush` |
| `force` | `forceOverwrite` |
| `fileTypes` | `includeFileTypes` |
| `ignore` | `ignorePatterns` |
| `maxParallelFiles` / `parallel` | `concurrencyLimit` |
| `maxRetries` / `retryMax` | `retryConfig.maxRetries` |
| `initialRetryDelay` / `retryDelay` | `retryConfig.initialDelay` |
| `retryDelayFactor` / `retryBackoff` | `retryConfig.backoffFactor` |
| `previewMode` / `preview` | `previewOnly` |
| `yes` | `nonInteractive` |
| `grayRelease` / `conflictResolution` / `webhook` / `branchStrategy` | 对应的 `*Config` 对象 |

别名值会做类型强制转换，转不动就是硬错误（例如 `maxRetries: "abc"` → `配置项 maxRetries 需要数字`）。

这些键已随重构移除，写了只会得到废弃警告：`cache`、`cacheConfig`、`adaptiveConcurrency`（并发度只由 `concurrencyLimit` 决定）。

未识别的键不会被静默丢弃，会提示 `未识别的配置项 xxx 已忽略（拼写错误不会产生任何效果）`。

## 忽略规则放哪里

忽略来源按优先级叠加，越靠后越优先（`src/fsx/ignore-source.ts`）：

1. 内置规则：`.git/`、`node_modules/`、`.sync-cache/`、`.sync-temp/`、`.sync-hashes.json`、`.sync-state.json`、`.DS_Store`
2. 仓库根 `.gitignore`
3. 仓库根 `.syncignore`（工具专用，不会污染 git 的忽略语义）
4. 配置里的 `ignorePatterns`
5. 各同步目录内嵌套的 `.gitignore`（层级越深越晚求值，因而胜出）

语法是 gitignore 语义：`#` 注释、`!` 取反、结尾 `/` 只匹配目录、开头 `/` 锚定、`**` 跨目录。注意内置规则**故意不含** `dist`/`build`——它们是真实的项目产物，是否同步由你决定。

## 下一步

字段级完整说明见 [配置参考](/reference/configuration)，参数级说明见 [命令行参考](/reference/cli)，命令动作见 [使用总览](/guide/usage)。
