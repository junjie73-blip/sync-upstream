# 功能记录

只列当前版本**真实可用**的功能，每项都写明怎么用和行为边界。设计理由、内部实现不在这页——那是使用指南，不是贡献者文档。

## 同步核心

### 目录级作用域
- **能做什么**：只同步 `syncDirs` 列出的路径，范围外的文件不被读取、修改或提交
- **怎么用**：`syncDirs` 或 `-d a,b`；条目可以是目录，也可以是**单个文件路径**
- **注意**：作用域按"路径等于该条目或位于该条目之下"匹配，所以 `packages/shared` 不会匹配 `packages/shared-utils`
- **文档**：[日常同步](/guide/sync-basics) · [单文件与局部同步](/guide/automation#单文件与局部同步)

### 预览等于结果
- **能做什么**：先列出这次要新增 / 修改 / 删除的每一条路径，确认后再执行；预览清单与提交内容严格一致
- **怎么用**：`-P`（或脚本里用 `-n`），加 `-V` 打印完整清单
- **注意**：预览仍会拉取上游并更新 `sync-upstream` remote，离线时会失败
- **文档**：[先看再动](/guide/sync-basics#先看再动)

### 增量同步
- **能做什么**：上次已经同步过的内容自动跳过，只处理之后变化的文件
- **怎么用**：`--incremental`（或 `forceOverwrite: false`）；`--force` 忽略基线重新全量比对
- **注意**：基线记在 `.sync-state.json`，换上游仓库或分支时自动作废重建；删掉不会损坏什么，但增量基线、`history` 记录与 `--undo` 的参照一起消失，下一次只能全量比对
- **文档**：[全量与增量](/guide/sync-basics#全量与增量) · [运行产物与清理](/reference/configuration#运行产物与清理)

### 并行应用与失败局部化
- **能做什么**：文件多时批量应用；个别文件失败只标记该文件并保留原因，其余照常完成
- **怎么用**：`concurrencyLimit` / `--concurrency`
- **注意**：存在失败文件时退出码为 1，修好原因后重跑即可，已成功的部分不会重复处理
- **文档**：[并发与重试](/guide/automation#并发与重试)

### 忽略规则
- **能做什么**：按 gitignore 语义排除文件，支持 `!` 取反、`/` 锚定、`**` 跨目录
- **怎么用**：`ignorePatterns` / `--ignore`，扩展名白名单 `includeFileTypes` / `--include-types`
- **注意**：叠加顺序是内置规则 → 根 `.gitignore` → `.syncignore` → 配置项 → 同步目录内嵌套 `.gitignore`，后写的优先级更高
- **文档**：[忽略规则放哪里](/guide/configuration#忽略规则放哪里)

### 仓库锁
- **能做什么**：同一个仓库同一时刻只允许一次真实同步，两个进程互相踩不到的写法从"运气好"变成保证
- **怎么用**：无需开启；被别人占用时用 `--lock-wait 30000` 等待，默认 `0` 表示立即失败
- **注意**：锁写在 `.git/sync-upstream.lock`；持有者进程已退出或超时时自动接管，不会留下需要人工清理的死锁；`doctor` 会告诉你锁在谁手里
- **文档**：[并发与重试](/guide/automation#并发与重试) · [运行产物与清理](/reference/configuration#运行产物与清理)

### 多上游与任意 ref
- **能做什么**：一次运行按顺序合并多个上游（fan-in），源也可以是标签或提交号，不限于分支
- **怎么用**：配置里写 `upstreams: [{ repo, ref }]`，或命令行重复 `-r A -r B -b main -b v1.8.0` 按位置配对
- **注意**：每个上游有自己的状态文件与自己的专属 remote，两个上游不会互相把对方的改动标成"已同步"；多上游模式下不支持灰度发布、`--rollback` 与 `--full-release`，会被明确拒绝而不是静默忽略
- **文档**：[多上游同步](/guide/sync-basics)

### 重命名识别
- **能做什么**：上游把文件改名时同步成"改名"，而不是"删一个 + 新增一个"，历史与评审diff都更短
- **怎么用**：默认开启（`renameDetection: true`）；`--no-renames` 关掉，`--rename-threshold 80` 调相似度门槛（默认 60）
- **注意**：相似度不到门槛仍按删除 + 新增处理；改名识别不影响最终内容，只影响变更清单怎么呈现
- **文档**：[重命名与删除](/guide/sync-basics)

### 上游删除怎么办
- **能做什么**：上游删掉的文件，可以选择跟着删、保留本地、或每次问你
- **怎么用**：`deletePolicy: mirror | keep | ask`，命令行 `--delete-policy`、`--delete`、`--no-delete`
- **注意**：`ask` 需要交互终端，非交互运行时按保留本地处理；预览会列出"上游删除但被保留"的文件，便于事后单独清理
- **文档**：[删除策略](/guide/sync-basics)

### 大仓库抓取与 Git LFS
- **能做什么**：只取回需要的对象（partial clone）、限制历史深度，并识别 Git LFS 指针
- **怎么用**：`--fetch-filter blob`（或 `tree`）、`--fetch-depth 50`、`--fetch-tags` / `--no-fetch-tags`、`--lfs pointer | materialize | off`（默认 `pointer`）
- **注意**：这几个开关只改变"从上游取回什么"，不改变同步判定；`--lfs materialize` 需要本机装了 `git-lfs`，没装时不报错，只在报告里说明指针保持原样
- **文档**：[大仓库抓取](/guide/sync-basics)

## 先看后动，动了能撤

### 四个只读子命令
- **能做什么**：不动工作区地回答"现在什么状态 / 这个文件为什么没同步 / 环境哪里不对 / 最近同步了什么"
- **怎么用**：`sync-upstream status [--fetch]`、`sync-upstream why <仓库内路径>`、`sync-upstream doctor`、`sync-upstream history [--limit <n>]`
- **注意**：`status` 默认不联网，加 `--fetch` 才真的比对上游；`history` 读的是每次真实同步留下的记录，默认显示 10 条；四个命令都能 `--json`，stdout 只输出那一个 JSON 文档
- **文档**：[不改动任何东西的四个子命令](/guide/usage#不改动任何东西的四个子命令) · [CLI 参考 → 子命令](/reference/cli#子命令)

### 撤销最近一次同步
- **能做什么**：把上一次真实同步的应用整体退回去
- **怎么用**：`sync-upstream --undo`（`-uo`）
- **注意**：不联网，也不接受任何同步参数；撤销本身也会记录进历史，`--json` 同样可用
- **文档**：[撤销最近一次同步](/guide/sync-basics#撤销最近一次同步)

## 冲突处理

### 冲突识别
- **能做什么**：自动标出本地与上游都有改动的文件，共 4 类：`content`（内容都改）、`delete-modify`（一边删一边改）、`untracked-overwrite`（本地未跟踪文件将被覆盖）、`type`（文件与目录同名冲突）
- **怎么用**：无需开启，计划输出里的 `冲突: N 个文件` 就是它们
- **注意**：只有真实运行才需要处理决策，预览只报告不处理
- **文档**：[会产生哪几类冲突](/guide/conflicts#会产生哪几类冲突)

### 五种解决策略
- **能做什么**：按策略处理冲突：`use-source` 采用上游、`keep-target` 保留本地、`auto-merge` 尝试合并、`prompt-user` 逐个询问、`skip` 跳过
- **怎么用**：`--conflict-strategy <s>` 或 `conflictResolutionConfig.defaultStrategy`；策略值写错会直接报校验错误，不会静默按默认处理
- **注意**：`-y` 且策略为 `prompt-user` 时自动按保留本地处理并给出警告
- **文档**：[五种解决策略](/guide/conflicts#五种解决策略) · [非交互模式下的行为](/guide/conflicts#非交互模式下的行为)

### 三方合并
- **能做什么**：`auto-merge` 尽量自动合并双方的行级改动；合不上时在文件里写入 `<<<<<<< LOCAL` / `=======` / `>>>>>>> UPSTREAM` 标记交给你处理
- **怎么用**：`--conflict-strategy auto-merge`
- **注意**：单文件超过约 2 万行时不做自动合并（会拖慢并产生无意义结果），改为保留冲突双方供手工处理；二进制文件不尝试合并
- **文档**：[auto-merge 怎么合](/guide/conflicts#auto-merge-怎么合)

### 按扩展名放行
- **能做什么**：指定扩展名在 `prompt-user` 下不提问
- **怎么用**：`conflictResolutionConfig.autoResolveTypes: [".md"]`
- **注意**：放行等于**保留本地**，不是自动合并；要自动合并请把 `defaultStrategy` 设为 `auto-merge`
- **文档**：[按扩展名放行](/guide/conflicts#按扩展名放行)

## 发布控制

### 灰度发布
- **能做什么**：先发一小部分文件、验证、再补齐其余
- **怎么用**：`-gr` 开启，`--strategy percentage|directory|file` 选法，`--percentage 20` / `--canary-dirs` / `--file-patterns` 定量
- **注意**：同一批文件的选择是确定性的——重跑同样的百分比得到同一批；选择结果为空会直接报错
- **文档**：[灰度发布与回滚](/guide/gray-release)

### 灰度校验
- **能做什么**：金丝雀发布后跑你自己的校验命令，非 0 退出即判校验失败
- **怎么用**：`--validation-script "pnpm test"`，超时与重试次数用 `grayReleaseConfig` 调
- **注意**：单条校验命令最长 120 秒后被强制结束；输出只保留前 4000 字符；校验失败**默认不自动回滚**，需要 `rollbackOnFailure: true`
- **文档**：[配置样例](/guide/gray-release#配置样例)

### 全量发布与回滚
- **能做什么**：`-fr` 发布剩下的文件；`-ro` 把已经发布的内容退回发布前
- **怎么用**：`-gr --full-release` / `-gr --rollback`（回滚也要带 `-gr`，因为它依赖灰度进度记录）
- **注意**：回滚是**新提交一条回滚提交**，不是 `git reset`，已推送的历史不会被改写；`.sync-gray.json` 在灰度进行中不要删除
- **文档**：[回滚做了什么](/guide/gray-release#回滚做了什么) · [运行产物与清理](/reference/configuration#运行产物与清理)

### GitOps：改动走 PR 而不是直接落分支
- **能做什么**：把本次同步提交到一个自动生成的分支并推送，目标分支保持不动，由评审决定合不合
- **怎么用**：`--pr`（或 `prConfig.enable: true`），配 `--pr-branch` / `--pr-remote` / `--pr-title` / `--pr-body` / `--pr-draft` / `--pr-no-create`
- **注意**：`--pr-no-create` 只推分支、不尝试建 PR；机器上装了 `gh` / `glab` 等 CLI 且远程认得出来时才会尝试创建，装不上只提示链接，不会让同步失败；没有可推送的远程时直接报错
- **文档**：[PR 模式](/guide/sync-basics) · [参数组的行为边界](/reference/cli#参数组的行为边界)

## 触发与集成

### 认证
- **能做什么**：私有仓库读取，三种方式：`ssh` / `pat` / `user_pass`
- **怎么用**：`--auth-type` 加对应凭据参数，或写 `authConfig`；不给 `--auth-type` 时其余认证字段不生效
- **注意**：日志与报错里的 URL 一律脱敏；`pat` / `user_pass` 会把凭据写进 `.git/config` 的 remote URL，别把该文件贴出去
- **文档**：[私有仓库认证](/guide/quick-start#私有仓库认证) · [参数组的行为边界](/reference/cli#参数组的行为边界)

### 分支策略
- **能做什么**：在派生分支上完成同步，方便评审后再合回
- **怎么用**：`branchStrategyConfig.enable: true`，`strategy` 取 `feature` / `release` / `hotfix` / `develop`，`branchPattern` 默认 `feature/sync-{date}`（支持 `{date}`、`{base}`、`{strategy}`）
- **注意**：只在真实运行生效，预览不切分支；基准分支不存在直接报错；`autoSwitchBack`（默认开）在提交完成后把分支切回运行前所在分支，`autoDeleteMergedBranches`（默认关）删除本工具生成、已合入目标分支且当前未检出的同步分支——`git branch -d` 拒绝删除未合并的分支，所以它不会误删
- **文档**：[分支策略](/guide/sync-basics#分支策略)

### Webhook 守护模式
- **能做什么**：常驻接收上游事件，符合条件就触发一次同步
- **怎么用**：`-we`，配 `--webhook-port` / `--webhook-path` / `--webhook-secret` / `--webhook-events` / `--webhook-branch`，运维相关用 `--webhook-host` / `--webhook-log` / `--webhook-queue`
- **注意**：支持 GitHub / GitLab / Bitbucket / Gitea，平台按每次请求识别；secret 为空时任何请求都被拒（401）；请求体上限 1 MiB（可调 `maxBodyBytes`）；先应答再后台同步，后台失败只记日志不会回传给上游；默认只绑 `127.0.0.1`，要让外部访问必须显式改 `host`；`port: 0` 交给系统分配端口；`GET /healthz` 是存活探针（可改名或关掉）；同一事件默认去重，投递决策逐条写进 `deliveryLog`；并发投递超过 `maxQueue`（默认 8）返回 503 请平台稍后重投；`trustProxy` 没开时不看 `x-forwarded-for`
- **文档**：[Webhook 守护模式](/guide/webhook) · [请求处理的顺序](/guide/webhook#请求处理的顺序)

### 通知钩子
- **能做什么**：同步结束后把结果推给 HTTP 回调、Slack、钉钉、企业微信，或直接打到 stdout
- **怎么用**：`notifyConfig` 选通道与事件，命令行 `--notify slack,dingtalk` / `--notify-url` / `--notify-events` / `--no-notify`
- **注意**：机器人的真实地址写在配置文件里而不是命令行（命令行对同机其它进程可见）；通知失败不影响同步结果与退出码，只在日志里留一条；默认事件是成功、冲突、失败、撤销四类
- **文档**：[通知钩子](/guide/automation) · [配置参考](/reference/configuration)

### 失败重试
- **能做什么**：网络抖动导致的上游拉取失败自动退避重试，其他错误立即抛出
- **怎么用**：`retryConfig` / `--retry-max` `--retry-delay` `--retry-backoff`
- **注意**：重试只作用于拉取上游这一步，应用与提交阶段失败不重试（重跑整条命令即可）
- **文档**：[并发与重试](/guide/automation#并发与重试)

### 日志与退出码
- **能做什么**：分级日志、可落盘的滚动日志、机器可读输出，以及可分流的退出码
- **怎么用**：`-V` 更详细、`-s` 只留错误、`--debug` 打开最底层调试；`--log-file runs/sync.log` 落盘，`--log-level` / `--log-max`（默认 5 MiB）/ `--log-keep`（默认 5 份）/ `--log-json` 控制内容；`--json` 让只读子命令输出单个 JSON 文档；`0` 成功（含无变更与预览）、`1` 有失败文件、`2` 配置或参数问题、`3` git 操作失败、`4` 在 `init` 问答里取消、`5` 仓库被另一次同步占用
- **注意**：同步过程中按 `Ctrl+C` 取消不算失败，它按"保留本地"处理后仍以 `0` 结束，`4` 只来自 `init`；日志文件按大小滚动，删掉旧文件不影响任何功能
- **文档**：[日志](/guide/automation#日志) · [退出码](/guide/automation#退出码) · [日志与错误](/reference/api#日志与错误)

## 上手与终端体验

### 引导式 init
- **能做什么**：回答几个问题就得到一份可用的配置文件，只写你回答过的字段
- **怎么用**：`sync-upstream init`，`-F yaml|toml|json5|json` 选格式，`-C` 选路径，`-f` 允许覆盖
- **注意**：答案先通过校验再落盘，所以不会出现"生成的文件下一跑就拒绝加载"；已存在目标文件时必须 `-f`；需要交互终端，带 `--json`、`-y` 或在 CI 里会被拒绝（退出码 2），那种场景改用 `--generate-config`
- **文档**：[生成配置](/reference/cli#生成配置-generate-config-与-init) · [快速开始](/guide/quick-start)

### 中英双语输出
- **能做什么**：帮助、参数报错与运行期错误按语言给出，中文与英文是同一份文案的两种写法
- **怎么用**：`--lang zh|en` 临时切换，`SYNC_UPSTREAM_LANG` 固定给本工具，否则读 `LC_ALL` / `LANG` / `LANGUAGE`
- **注意**：判定顺序是 `SYNC_UPSTREAM_LANG` > `LC_ALL` > `LANG` > `LANGUAGE`；`zh*` 走中文，其它已识别 locale 走英文；四项都没给（或只给了 `C` / `POSIX`）时走中文默认值，工具不会去读系统区域设置的其它来源——想在没有 locale 的容器里拿到英文，就显式设一个；`--lang` 只影响输出语言，不写进配置；填错值时用你原本的语言解释原因
- **文档**：[语言（`--lang`）](/reference/cli#语言-lang)

### Shell 补全
- **能做什么**：子命令、参数与 shell 名在 bash / zsh / fish 里可补全
- **怎么用**：`sync-upstream completion bash|zsh|fish` 重定向到对应补全目录
- **注意**：脚本由当前参数表生成，升级后重新生成一次才有新参数；它不猜仓库地址，也不补全配置文件路径之外的东西
- **文档**：[补全脚本](/reference/cli#补全脚本) · [安装](/guide/installation)

## 不支持（避免误解）

- 不改写你的 `origin`，只维护名为 `sync-upstream` 的专属 remote（多上游时是 `sync-upstream-2` 这样的第二个 remote）
- 不同步子模块指针
- 不保留上游提交历史：同步的是内容，不是 commit
- 多上游（`upstreams`）不支持灰度发布、`--rollback` 与 `--full-release`，会被明确拒绝；要灰度请一次只配一个上游
- 不管理 Git LFS 的对象存储：只识别指针文件，按 `--lfs` 选择保持原样、调用本机 `git-lfs` 取回实体，或完全忽略
- 不做定时任务、可视化仪表盘、许可证扫描、权限管理、多环境配置、冲突自动建议
- 通知只到 HTTP 回调 / Slack / 钉钉 / 企业微信 / stdout，不发邮件
- 只读环境变量为有限几项：判定语言用的 `SYNC_UPSTREAM_LANG`、`LC_ALL`、`LANG`、`LANGUAGE`，把摘要写进 GitHub Actions 页面时用的 `GITHUB_STEP_SUMMARY`，以及 `SYNC_UPSTREAM_PR_CREATE=0`（跳过自动创建 PR）。仓库凭据仍不会从环境变量读取，只能来自配置文件与命令行
- `--lang en` 覆盖的是帮助、参数报错、错误消息与 `init` 问答；同步流程里的补全问答、冲突询问与删除确认、配置摘要、运行日志与 `status` / `doctor` / `why` / `history` 的输出正文目前仍是中文（需要机器可读内容请用 `--json`）

## 相关页面

- [使用总览](/guide/usage)：按任务找文档
- [常见问题](/faq)：报错与行为疑问
- [更新日志](/changelog)：版本间变更
- [下一版计划](/roadmap)：上面这些限制打算什么时候解除
