# 命令行参考

本页逐条列出 `sync-upstream` 的命令行参数、别名、默认值，以及它们写进配置层的哪个键。字段含义见 [配置参考](/reference/configuration)，用法场景见 [使用总览](/guide/usage)。

## 解析与优先级

配置由三层深合并而成，后一层覆盖前一层：

```text
默认值  →  配置文件  →  命令行
```

命令行只在你真的给了某个参数时才覆盖对应配置，没给的值不会把文件里的配置擦掉。嵌套对象（`retryConfig`、`conflictResolutionConfig`、`grayReleaseConfig`、`webhookConfig`）是深合并，数组（`syncDirs`、`ignorePatterns`、`includeFileTypes`）是整体替换。

命令按固定顺序处理参数与运行意图：

```text
1. --version        打印版本号，退出码 0
2. --help           打印帮助，退出码 0
3. --generate-config 生成配置文件后退出（不校验其余参数）
4. 未知参数检查      有未知参数 → 报错并返回退出码 2
5. 读配置文件 + 合并命令行 + 校验
6. 设置日志级别（看命令行的 -V / -s）
7. 交互补全（除非 -y 且配置完整）
8. 打印配置摘要
9. webhookConfig.enable → 守护模式；否则执行同步
```

因为前三步在未知参数检查之前，`sync-upstream -g --不存在的参数` 会正常生成配置而不是报错。

## 参数总表

字符串参数需要值，列表参数用逗号分隔（可重复给，值会被展平再按逗号拆分）。

| 长参数 | 短参数 | 类型 | 默认 | 写入配置键 |
|---|---|---|---|---|
| `--repo` | `-r` | string | `''` | `upstreamRepo` |
| `--branch` | `-b` | string | `main` | `upstreamBranch` |
| `--company-branch` | `-c` | string | `main` | `companyBranch` |
| `--dirs` | `-d` | list | `[]` | `syncDirs` |
| `--message` | `-m` | string | `Sync upstream changes to specified directories` | `commitMessage` |
| `--config` | `-C` | string | 自动发现 | 指定配置文件路径；读取失败直接报错 |
| `--config-format` | `-F` | string | `json` | 仅影响 `--generate-config` 的产物格式 |
| `--ignore` | | list | `[]` | `ignorePatterns`（追加，gitignore 语法） |
| `--include-types` | | list | `[]` | `includeFileTypes`（如 `.ts,.vue`） |
| `--concurrency` | | string→number | `10` | `concurrencyLimit` |
| `--retry-max` | | string→number | `3` | `retryConfig.maxRetries` |
| `--retry-delay` | | string→number | `2000` | `retryConfig.initialDelay` |
| `--retry-backoff` | | string→number | `1.5` | `retryConfig.backoffFactor` |
| `--conflict-strategy` | | string | `prompt-user` | `conflictResolutionConfig.defaultStrategy` |
| `--auth-type` | | string | 无 | `authConfig.type` |
| `--auth-username` | | string | 无 | `authConfig.username` |
| `--auth-token` | | string | 无 | `authConfig.token` |
| `--auth-password` | | string | 无 | `authConfig.password` |
| `--auth-key` | | string | 无 | `authConfig.privateKeyPath` |
| `--strategy` | | string | `percentage` | `grayReleaseConfig.strategy` |
| `--percentage` | | string→number | `20` | `grayReleaseConfig.percentage` |
| `--canary-dirs` | | list | 无 | `grayReleaseConfig.canaryDirs` |
| `--file-patterns` | | list | 无 | `grayReleaseConfig.filePatterns` |
| `--validation-script` | | string | 无 | `grayReleaseConfig.validationScript` |
| `--webhook-port` | | string→number | `3000` | `webhookConfig.port` |
| `--webhook-path` | | string | `/webhook` | `webhookConfig.path` |
| `--webhook-secret` | | string | `''` | `webhookConfig.secret` |
| `--webhook-events` | | list | `push` | `webhookConfig.allowedEvents` |
| `--webhook-branch` | | string | `main` | `webhookConfig.triggerBranch` |

布尔参数不给即为 `false`，没有 `--no-xxx` 形式：

| 长参数 | 短参数 | 效果 |
|---|---|---|
| `--push` | `-p` | `autoPush = true`（无法用命令行把它强制设回 `false`） |
| `--force` | `-f` | `forceOverwrite = true` |
| `--incremental` | | `forceOverwrite = false`；与 `-f` 同时给时以本条为准 |
| `--dry-run` | `-n` | `dryRun = true`，只打印计划 |
| `--preview-only` | `-P` | `previewOnly = true`，效果与 `-n` 相同，提示文案不同 |
| `--non-interactive` | `-y` | `nonInteractive = true` |
| `--verbose` | `-V` | `verbose = true` 并把日志级别设为 verbose |
| `--silent` | `-s` | `silent = true` 并把日志级别设为 error（`-V` 优先） |
| `--generate-config` | `-g` | 生成配置文件后退出，不执行同步 |
| `--gray-release` | `-gr` | `grayReleaseConfig.enable = true`，同时读取上表中的灰度参数 |
| `--full-release` | `-fr` | `fullRelease = true`，发布灰度剩余文件 |
| `--rollback` | `-ro` | `rollback = true`，回滚最近一次灰度 |
| `--webhook-enable` | `-we` | `webhookConfig.enable = true` |
| `--version` | `-v` | 打印版本 |
| `--help` | `-h` | 打印帮助 |

## 参数组的行为边界

**预览。** `previewOnly` 与 `dryRun` 任一为真即只出计划：不会切分支、不会写工作区、不会提交。仍会新增或校正 `sync-upstream` 这个 remote 并联网拉取上游，因此离线时预览照样失败。

**灰度。** 灰度相关参数只在 `-gr` 出现时才写入配置：单独给 `--percentage 30` 而不带 `-gr` 是无效组合。`--percentage` 必须带值，写成 `--percentage` 空值会被解析成 `0` 并触发"percentage 必须在 (0, 100] 内"的校验错误。`-fr` 与 `-ro` 是运行意图开关，不需要 `-gr` 之外的前置条件，但 `-ro` 要求灰度配置存在，否则报 `--rollback 需要同时启用 grayReleaseConfig`。

**Webhook。** `-we` 会把 `supportedPlatforms` 固定成 `['github']`（数组是整体替换，配置文件里的平台列表会被它盖掉）。要接 GitLab/Gitea/Bitbucket，请在配置文件里写 `webhookConfig.enable: true` 和 `supportedPlatforms`，不带 `-we` 同样会进入守护模式。secret 为空时所有请求一律 `401`，服务本身仍会正常监听。

**认证。** 只有给了 `--auth-type` 才会生成 `authConfig`，其余四个认证字段单独出现时不生效。凭据会被拼进远端 URL，日志与错误信息里的 URL 一律经过脱敏，但 `.git/config` 中 `sync-upstream` 这条 remote 的 URL 会包含凭据。

## 交互与 `-y`

是否提问由一个条件决定：

```text
interactive = !nonInteractive || 配置不完整
配置不完整 ⇔ upstreamRepo 为空 || syncDirs 为空
```

所以 `-y` 只在配置完整时保证零提问；缺 `upstreamRepo` 或 `syncDirs` 时即使带 `-y` 也会进入补全问答。补全会先问缺失的必填项（上游 URL、同步目录、上游分支、目标分支、提交消息），再固定问五个可选项：自动推送、预览模式、失败重试并发数、冲突处理方式、以及最后的"确认开始同步?"。按 `Ctrl+C` 取消会打印"操作已取消"并以退出码 `0` 结束。

## 未知参数

任何不在上表（含短别名）里的键都会让命令在进入同步前失败：

```text
无法识别的命令行参数: --puuush
使用 --help 查看全部可用参数
```

返回退出码 `2`。这条检查的存在是为了避免"参数打错了但被静默忽略"。

## 退出码

| 码 | 触发条件 |
|---|---|
| `0` | 成功；无变更可提交；预览运行；`--help`/`--version`/`--generate-config`；交互取消 |
| `1` | 未预期的错误；`NetworkError`/`TimeoutError`/`AuthenticationError` 等非分类错误；本次有文件应用失败 |
| `2` | `ConfigError`/`ValidationError`；未知命令行参数 |
| `3` | `GitError`（fetch、checkout、commit、push、引用或分支不存在） |
| `4` | `UserCancelError` 对应的保留码：当前取消路径直接以 `0` 结束，脚本不会观测到 4 |

完整分类见 [CI 与自动化](/guide/automation#退出码)。

## 生成配置

```bash
sync-upstream -g                          # ./sync-upstream.config.json
sync-upstream -g -F yaml                  # ./sync-upstream.config.yaml
sync-upstream -g -C ./cfg/my.toml         # 写到指定路径，格式由扩展名推断
```

`-C` 在生成模式下被复用为输出路径；`-F` 只在这里生效，读取配置时用文件扩展名判断格式。

## 相关页面

- [配置参考](/reference/configuration)：每个字段的类型、取值范围与别名
- [CLI 参考 → API](/reference/api)：同一套能力的库调用方式
- [使用总览](/guide/usage)：参数如何进入配置与常见使用场景
