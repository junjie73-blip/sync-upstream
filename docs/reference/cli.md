# 命令行参考

本页逐条列出 `sync-upstream` 的命令行参数、子命令、别名、默认值，以及它们写进配置层的哪个键。字段含义见 [配置参考](/reference/configuration)，用法场景见 [使用总览](/guide/usage)。

## 解析与优先级

配置由三层深合并而成，后一层覆盖前一层：

```text
默认值  →  配置文件  →  命令行
```

命令行只在你真的给了某个参数时才覆盖对应配置，没给的值不会把文件里的配置擦掉。嵌套对象（`retryConfig`、`conflictResolutionConfig`、`grayReleaseConfig`、`webhookConfig`、`fetchConfig`、`logConfig`、`notifyConfig`、`prConfig`）是逐键深合并，数组（`syncDirs`、`ignorePatterns`、`includeFileTypes`）是整体替换。

命令按固定顺序处理参数与运行意图：

```text
1. 语言判定          --lang → SYNC_UPSTREAM_LANG → LC_ALL → LANG → LANGUAGE，都没有则中文
2. --version         打印版本号，退出码 0
3. --help            按上一步判定的语言打印帮助，退出码 0
4. --generate-config 生成配置文件后退出（不校验其余参数）
5. completion        打印 shell 补全脚本后退出
6. init              引导式生成配置文件后退出
7. status/why/doctor/history 只读子命令，直接出报告
8. 未知参数检查      有未知参数 → 报错并返回退出码 2
9. 读配置文件 + 合并命令行 + 校验
10. 设置日志级别与日志落盘
11. 交互补全（除非 -y 且配置完整）
12. 打印配置摘要
13. webhookConfig.enable → 守护模式；否则执行同步
```

因为第 2～7 步在未知参数检查之前，`sync-upstream -g --不存在的参数` 会正常生成配置而不是报错。

## 语言（`--lang`）

帮助文本、参数报错与错误消息都跟随当前语言，`zh` 与 `en` 二选一。

| 写法 | 效果 |
|---|---|
| `--lang en` | 本次运行用英文 |
| `SYNC_UPSTREAM_LANG=en` | 只对本工具生效，优先级最高的环境变量 |
| `LC_ALL` / `LANG` / `LANGUAGE` | 没有上面两项时按系统 locale 判定；`zh*` 走中文，其它已识别 locale 走英文 |
| 四项都没给，或只给了 `C` / `POSIX` | 中文（默认值），工具不去读系统区域设置的其它来源 |

`--lang` 只给 i18n 用，不会写进配置层，也没有对应的配置键。给了不识别的值（`--lang klingon`）时，工具会用**你原本的语言**解释为什么拒绝，并且不改变当前语言。`sync-upstream --lang en --help` 是最快确认这台机器读哪种语言的办法。

## 子命令

`sync-upstream` 除了同步本身还有六个子命令，前四个只读、不写工作区也不提交。

| 子命令 | 用法 | 作用 |
|---|---|---|
| `status` | `sync-upstream status [--fetch] [--json]` | 当前分支、上游可达性、待同步文件数；不带 `--fetch` 时不联网 |
| `why` | `sync-upstream why <仓库内文件路径> [--json]` | 解释某个文件为什么会被同步/跳过/删除 |
| `doctor` | `sync-upstream doctor [--json]` | 体检：配置、git、远程、权限、状态文件、锁 |
| `history` | `sync-upstream history [--limit <n>] [--json]` | 最近若干次同步记录 |
| `init` | `sync-upstream init [-F yaml] [-C <路径>] [-f]` | 问答式生成配置文件 |
| `completion` | `sync-upstream completion <bash\|zsh\|fish>` | 打印补全脚本，重定向到你的补全目录 |

`status`/`why`/`doctor`/`history`/`init`/`completion` 都接受 `--config` 与 `--lang`；前四个还支持 `--json` 输出机器可解析的报告。

这四条里 `status`、`doctor`、`history` 和 `--undo` **在没有配置文件、或配置文件还缺字段时照样出报告**——它们正是给"还不知道哪里没配好"的人用的。缺失的字段会逐条出现在报告的 `warnings` 里（人类模式打在同一行 stderr 上），`doctor` 还会把它算作阻塞项，退出码 `1`。只有 `why` 仍然要求一份可用配置：它回答的是"这次同步会不会动这个文件"，没有配置就没有计划可依据，此时以退出码 `2` 报配置校验失败。

## 参数总表

字符串参数需要值，列表参数用逗号分隔（可重复给，值会被展平再按逗号拆分）。

| 长参数 | 短参数 | 类型 | 默认 | 写入配置键 |
|---|---|---|---|---|
| `--repo` | `-r` | string | `''` | `upstreamRepo`；重复给多个 `-r` 时展开成 `upstreams` 数组 |
| `--branch` | `-b` | string | `main` | `upstreamBranch`；与 `-r` 按位置配对，可写分支、标签或提交号 |
| `--company-branch` | `-c` | string | `main` | `companyBranch` |
| `--dirs` | `-d` | list | `[]` | `syncDirs` |
| `--message` | `-m` | string | `Sync upstream changes to specified directories` | `commitMessage` |
| `--config` | `-C` | string | 自动发现 | 指定配置文件路径；读取失败直接报错 |
| `--config-format` | `-F` | string | `json` | 仅影响 `--generate-config` 与 `init` 的产物格式 |
| `--lang` | | string | 按环境判定 | 不进配置，只切换输出语言 |
| `--ignore` | | list | `[]` | `ignorePatterns`（追加，gitignore 语法） |
| `--include-types` | | list | `[]` | `includeFileTypes`（如 `.ts,.vue`） |
| `--concurrency` | | string→number | `10` | `concurrencyLimit` |
| `--lock-wait` | | string→number | `0` | `lockWaitMs`，等别人释放仓库锁的毫秒上限，`0` 表示占用即失败 |
| `--retry-max` | | string→number | `3` | `retryConfig.maxRetries` |
| `--retry-delay` | | string→number | `2000` | `retryConfig.initialDelay` |
| `--retry-backoff` | | string→number | `1.5` | `retryConfig.backoffFactor` |
| `--conflict-strategy` | | string | `prompt-user` | `conflictResolutionConfig.defaultStrategy` |
| `--delete-policy` | | string | `mirror` | `deletePolicy`：`mirror`/`keep`/`ask` |
| `--rename-threshold` | | string→number | `60` | `renameThreshold`，相似度百分比 |
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
| `--fetch-filter` | | string | `none` | `fetchConfig.filter`：`none`/`blob`/`tree`（`blob` 即 git 的 `--filter=blob:none`） |
| `--fetch-depth` | | string→number | 无 | `fetchConfig.depth`，浅克隆层数 |
| `--lfs` | | string | `pointer` | `fetchConfig.lfs`：`pointer`/`materialize`/`off` |
| `--notify` | | list | 无 | `notifyConfig.enable = true` + `channels` |
| `--notify-url` | | string | 无 | `notifyConfig.url`，并自动补上 `http` 通道 |
| `--notify-events` | | list | 无 | `notifyConfig.events` |
| `--pr-branch` | | string | 无 | `prConfig.branchPattern` |
| `--pr-remote` | | string | 无 | `prConfig.remote` |
| `--pr-title` | | string | 无 | `prConfig.title` |
| `--pr-body` | | string | 无 | `prConfig.body` |
| `--webhook-port` | | string→number | `3000` | `webhookConfig.port`（给 `0` 用随机端口） |
| `--webhook-host` | | string | `127.0.0.1` | `webhookConfig.host` |
| `--webhook-path` | | string | `/webhook` | `webhookConfig.path` |
| `--webhook-secret` | | string | `''` | `webhookConfig.secret` |
| `--webhook-events` | | list | `push` | `webhookConfig.allowedEvents` |
| `--webhook-branch` | | string | `main` | `webhookConfig.triggerBranch` |
| `--webhook-log` | | string | 无 | `webhookConfig.deliveryLog`，投递审计文件 |
| `--webhook-queue` | | string→number | `8` | `webhookConfig.maxQueue` |
| `--log-file` | | string | 无 | `logConfig.file`，日志落盘路径 |
| `--log-level` | | string | `info` | `logConfig.level` |
| `--log-max` | | string→number | `5242880` | `logConfig.maxBytes`，单文件上限 |
| `--log-keep` | | string→number | `5` | `logConfig.keep`，保留几个历史文件 |
| `--limit` | | string→number | `10` | 只给 `history` 用，不进配置 |

布尔参数不给即为 `false`；下表之外还支持 `--no-delete`、`--no-renames`、`--no-pr`、`--no-fetch-tags`、`--no-notify` 这类否定写法（见"否定形式"）。

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
| `--debug` | | 日志级别设为 debug |
| `--json` | | 子命令输出机器可解析的 JSON |
| `--fetch` | | 让 `status` 真的联网拉取上游再比对 |
| `--generate-config` | `-g` | 生成配置文件后退出，不执行同步 |
| `--delete` | | `deletePolicy = 'mirror'` |
| `--renames` | | `renameDetection = true` |
| `--fetch-tags` | | `fetchConfig.tags = true` |
| `--pr` | | `prConfig.enable = true`，同时读取上表中的 PR 参数 |
| `--pr-draft` | | `prConfig.draft = true` |
| `--pr-no-create` | | `prConfig.create = 'never'`，只推分支不建 PR |
| `--undo` | `-uo` | 撤销最近一次同步，不联网 |
| `--gray-release` | `-gr` | `grayReleaseConfig.enable = true`，同时读取上表中的灰度参数 |
| `--full-release` | `-fr` | `fullRelease = true`，发布灰度剩余文件 |
| `--rollback` | `-ro` | `rollback = true`，回滚最近一次灰度 |
| `--webhook-enable` | `-we` | `webhookConfig.enable = true` |
| `--log-json` | | `logConfig.json = true`，日志文件写成每行一个 JSON 对象 |
| `--no-notify` | | `notifyConfig.enable = false` |
| `--no-delete` | | `deletePolicy = 'keep'` |
| `--no-renames` | | `renameDetection = false` |
| `--no-pr` | | `prConfig.enable = false` |
| `--no-fetch-tags` | | `fetchConfig.tags = false` |
| `--no-log-json` | | `logConfig.json = false`，回到人可读的 `[时间] [级别] 文本` |
| `--version` | `-v` | 打印版本 |
| `--help` | `-h` | 打印帮助 |

## 否定形式

`--no-xxx` 存在的意义是"配置文件里开了，这一次想关掉"。`--delete`、`--renames`、`--pr`、`--fetch-tags`、`--log-json`、`--notify` 六个开关都成对支持肯定与否定写法，两种写法都会盖掉配置文件里的取值；这些开关没有短别名。`--notify` 是否定写法里唯一同时被声明成布尔开关的（`--no-notify` 两种解析结果都能关掉通知）。

## 参数组的行为边界

**预览。** `previewOnly` 与 `dryRun` 任一为真即只出计划：不会切分支、不会写工作区、不会提交。仍会新增或校正 `sync-upstream` 这个 remote 并联网拉取上游，因此离线时预览照样失败。

**灰度。** 灰度相关参数只在 `-gr` 出现时才写入配置：单独给 `--percentage 30` 而不带 `-gr` 是无效组合。`--percentage` 必须带值，写成 `--percentage` 空值会被解析成 `0` 并触发"percentage 必须在 (0, 100] 内"的校验错误。`-fr` 与 `-ro` 是运行意图开关，不需要 `-gr` 之外的前置条件，但 `-ro` 要求灰度配置存在，否则报 `--rollback 需要同时启用 grayReleaseConfig`。

**Webhook。** `-we` 会把 `supportedPlatforms` 写成 `github、gitlab、bitbucket、gitea` 四个（数组是整体替换，配置文件里的平台列表会被它盖掉）；平台是按每次请求识别的，所以接 GitLab 也照样带 `-we`。要在配置文件里精确控制平台列表时，写 `webhookConfig.enable: true` 和 `supportedPlatforms`，不带 `-we` 同样会进入守护模式。secret 为空时所有请求一律 `401`，服务本身仍会正常监听。`--webhook-port 0` 让系统分配端口，配合 `--webhook-log` 与 `history` 排查投递。

**抓取与 LFS。** `--fetch-filter blob`（或 `tree`）、`--fetch-depth <n>`、`--fetch-tags/--no-fetch-tags`、`--lfs pointer|materialize|off` 各自单独写入，所以 `--fetch-depth 1` 不会把配置文件里其它 `fetchConfig` 字段清空。这几个参数只影响"从上游取回什么"，不改变同步判定。`--lfs materialize` 需要本机装了 `git-lfs`，没装时不会失败，只会在报告里说明指针保持原样。

**认证。** 只有给了 `--auth-type` 才会生成 `authConfig`，其余四个认证字段单独出现时不生效。凭据会被拼进远端 URL，日志与错误信息里的 URL 一律经过脱敏，但 `.git/config` 中 `sync-upstream` 这条 remote 的 URL 会包含凭据。

**通知。** `--notify slack,dingtalk` 只负责打开通道并列出通道名；真正的地址写在配置文件里，因为聊天机器人 URL 是凭据，放进命令行等于暴露给同机的其它进程。`--notify-url` 是例外，方便 CI 临时接一个 HTTP 回调。

**PR 模式。** `--pr` 让本次改动提交到自动生成的分支并推送，目标分支保持不动；`--pr-no-create` 只推分支、不尝试创建 PR。没有可用远程时 PR 模式会直接报错，因为分支推不出去。

## 交互与 `-y`

是否提问由一个条件决定：

```text
interactive = !nonInteractive || 配置不完整
配置不完整 ⇔ upstreamRepo 为空 || syncDirs 为空
```

所以 `-y` 只在配置完整时保证零提问；缺 `upstreamRepo` 或 `syncDirs` 时即使带 `-y` 也会进入补全问答。补全会先问缺失的必填项（上游 URL、同步目录、上游分支、目标分支、提交消息），再固定问五个可选项：自动推送、预览模式、失败重试并发数、冲突处理方式、以及最后的"确认开始同步?"。按 `Ctrl+C` 取消会打印"操作已取消"并以退出码 `0` 结束。

问答文本目前固定是中文；要零提问，用 `init` 或 `--generate-config` 先把配置文件写好，再带 `-y`。

## 生成配置：`--generate-config` 与 `init`

```bash
sync-upstream -g                          # ./sync-upstream.config.json
sync-upstream -g -F yaml                  # ./sync-upstream.config.yaml
sync-upstream -g -C ./cfg/my.toml         # 写到指定路径，格式由扩展名推断
sync-upstream init                        # 问答式，只写入你回答过的字段
sync-upstream init -F toml -f             # 生成 toml，允许覆盖已存在的文件
```

`-C` 在生成模式下被复用为输出路径；`-F` 只在这里和 `init` 生效，读取配置时用文件扩展名判断格式。

两者的区别：`--generate-config` 产出的是一份**全字段模板**，每个字段都带注释，适合对着文档改；`init` 是**问答**，只写你回答过的几项（仓库、目录、分支、提交消息、删除策略、冲突策略、是否自动推送、格式），其余走默认值。`init` 会先校验答案再落盘，所以它不会生成一个下一跑就拒绝加载的文件；目标文件已存在时需要 `-f` 才覆盖。`init` 需要交互终端，带 `--json` 或 `-y` 时会被拒绝（退出码 `2`），CI 里请改用 `--generate-config`。

## 补全脚本

```bash
# bash
sync-upstream completion bash > /usr/share/bash-completion/completions/sync-upstream
# zsh（放在 fpath 里的某个目录，文件名必须是 _sync-upstream）
sync-upstream completion zsh > "${fpath[1]}/_sync-upstream"
# fish
sync-upstream completion fish > ~/.config/fish/completions/sync-upstream.fish
```

脚本由当前参数表生成，所以升级后重新跑一次即可让新参数出现在补全里。`completion` 后跟 shell 名时还会补全 `bash`/`zsh`/`fish` 三个值。它只补全参数与子命令，不会替你猜仓库地址。

## 未知参数

任何不在上表（含短别名与 `--no-` 形式）里的键都会让命令在进入同步前失败：

```text
无法识别的命令行参数: --puuush
使用 --help 查看全部可用参数
```

返回退出码 `2`。这条检查的存在是为了避免"参数打错了但被静默忽略"。

## 退出码

| 码 | 触发条件 |
|---|---|
| `0` | 成功；无变更可提交；预览运行；`--help`/`--version`/`--generate-config`/`completion`；同步过程中的取消（按保留本地处理，运行继续收尾） |
| `1` | 未预期的错误；`NetworkError`/`TimeoutError`/`AuthenticationError` 等非分类错误；本次有文件应用失败；`--undo` 没有可撤销的记录 |
| `2` | `ConfigError`/`ValidationError`；未知命令行参数；`init` 缺少交互终端；多上游同时配了灰度 |
| `3` | `GitError`（fetch、checkout、commit、push、引用或分支不存在） |
| `4` | `UserCancelError`：目前只有 `init` 问答里按 `Ctrl+C` 或选"取消"会返回它 |
| `5` | `LockError`：仓库锁被另一次同步占用，且 `--lock-wait` 也没等到 |

完整分类见 [CI 与自动化](/guide/automation#退出码)。

## 相关页面

- [配置参考](/reference/configuration)：每个字段的类型、取值范围与别名
- [CLI 参考 → API](/reference/api)：同一套能力的库调用方式
- [使用总览](/guide/usage)：参数如何进入配置与常见使用场景
