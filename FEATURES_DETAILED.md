# sync-upstream 功能详解

本文按"代码里实际实现了什么"来记录功能状态，与 `src/` 一一对应。设计文档式的承诺不写在这里。

## 定位

sync-upstream 解决的是一个很具体的问题：**只把上游仓库的指定目录同步到我的分支，并且只提交这些目录的变更**。

它不试图取代 `git merge`。当你的诉求就是"整条分支全部合并"时，`git merge` 更合适；当诉求是"跟着上游的 `packages/runtime-core`，但保留我在 `apps/` 里的一切"，才需要这个工具。

### 关键实现选择

| 选择 | 原因 |
|---|---|
| 变更集合来自 git 对象库（`ls-tree` 两棵树比较 blob oid），不哈希工作区文件 | 与工作区状态无关，预览结果与最终提交严格一致；也避免了旧实现 md5 扫描全树的成本 |
| 不创建临时分支、不建临时目录 | 旧实现中断后会遗留脏分支与 `.sync-temp/`；现在唯一被移动的引用是 `refs/remotes/sync-upstream/<branch>` |
| 上游走专属 remote `sync-upstream` | 绝不改写用户的 `origin`，可安全删除后由下次运行重建。注意：`pat` / `user_pass` 认证会把凭据写进这条 remote 的 URL（即 `.git/config`），日志与错误里则一律脱敏；`ssh` 认证不落凭据 |
| 提交只带本次应用的路径列表（`commit --pathspec-from-file`） | 不会把工作区里其他人的未提交改动、未跟踪产物一起卷进提交 |
| 增量判定用 `.sync-state.json` 记录的 blob oid | oid 本身就是内容哈希，比"文件内容 md5 表"更准且无需重新读文件 |
| 真实同步前取 `.git/sync-upstream.lock`（`src/pipeline/repo-lock.ts`） | 两个进程同时同步同一仓库会交错提交；锁记录 pid/label/createdAt，pid 已退出或超时视为陈旧锁并自动接管，`ensureHeld()` 在提交前复查所有权 |
| fan-in 时每个上游一份状态文件（`stateFileFor`） | 状态是"路径 → 当时同步自哪个 blob"的映射，两个上游共用一份会把对方的改动误判为"已同步"而静默丢弃 |
| remote 按**仓库**而不是按源命名（`remoteNameFor`） | git 的 refspec 挂在 remote 上，同一上游的两个分支必须共用 `sync-upstream`；第二个上游仓库才用 `sync-upstream-2`，第一条保持原名以兼容既有配置 |
| 撤销与历史不另建数据库，历史写在状态文件的 `history` 数组里 | `--undo` 需要的信息（上次提交、涉及路径、基线提交）与增量判定本来就在同一份文件里；追加式写入，`history` 子命令只是把它读出来 |
| i18n 是一张 `key → 文案` 的双语目录（`src/i18n/catalog.ts`），中文是唯一事实源 | 英文条目必须与中文逐键对应（有 parity 测试守着）；中文文案与历史字符串逐字节相同，因此既有断言不需要改动就能继续通过 |
| 补全脚本由 CLI 自己的参数表生成（`completionSource()`） | 参数表只有一份事实来源；手维护脚本必然漂移，升级后新增参数不会出现在补全里 |
| `init` 在写盘前先跑一次 `buildConfig` 校验 | 问答生成的文件如果下一跑就被拒绝加载，等于把错误从命令行推迟到了运行时 |

## 功能状态

图例：✅ 已实现并有测试覆盖 · 🔄 部分实现（注明边界） · 📝 已规划未实现 · 💡 仅想法

### 同步核心

| 功能 | 状态 | 实现位置 | 说明 |
|---|---|---|---|
| 目录级作用域同步 | ✅ | `src/pipeline/plan.ts`、`src/pipeline/change-set.ts` | `syncDirs` 内逐路径比较；目录外表是一概不动 |
| 基于 tree 的差异检测 | ✅ | `src/git/repository.ts`（`listTree`） | 产出 `add` / `modify` / `delete` 三类变更，携带两侧 oid |
| 增量同步 | ✅ | `src/pipeline/sync-state.ts` | `forceOverwrite: false` 时跳过 oid 已记录的未变文件，记为 `already-synced` |
| 预览模式 | ✅ | `src/pipeline/orchestrator.ts` | `previewOnly` / `dryRun`：只算计划并打印，不切换分支、不修改工作区、不提交 |
| 并行应用 | ✅ | `src/concurrency.ts`、`src/pipeline/apply.ts` | `concurrencyLimit` 限并发；单路径失败只影响该路径，状态记为 `failed` |
| 忽略规则 | ✅ | `src/fsx/ignore-rules.ts`、`src/fsx/ignore-source.ts` | 内置规则 → 根 `.gitignore` → `.syncignore` → 配置 `ignorePatterns` → 各同步目录内嵌套 `.gitignore`（越深越优先）；自研 gitignore 语义编译，支持 `!` 取反、`/` 锚定、`**` |
| 扩展名白名单 | ✅ | `includeFileTypes` | 归一化为小写带点形式后精确匹配 |
| 大文件 / LFS | ✅ | `src/git/lfs.ts`、`fetchConfig.lfs` | 三种模式：`pointer` 原样保留指针（默认，最省）、`materialize` 调用本机 `git-lfs` 取回实体（没装时降级为警告并在报告里说明）、`off` 完全不管；指针靠内容前缀识别，不依赖 `.gitattributes`。旧的 `useLFS` / `largeFileThreshold` 配置仍不存在 |
| 大仓抓取 | ✅ | `src/pipeline/upstream-ref.ts`、`fetchConfig` | `filter`（`none`/`blob`/`tree` → git 的 `--filter=`）、`depth`（浅克隆）、`tags`（是否随取标签）；这些只改变取回什么，不参与计划判定 |
| 多上游 fan-in | ✅ | `src/pipeline/sources.ts`、`domain/upstream.ts` | `upstreams: [{repo, ref}]` 展开成多个 `SyncSource`，按顺序对同一目标分支执行"拉取 → 计划 → 应用 → 提交"；命令行重复 `-r`/`-b` 按位置配对生成同一结构。灰度、`--rollback`、`--full-release` 在多上游下被显式拒绝 |
| 任意 ref 作为源 | ✅ | `src/pipeline/upstream-ref.ts` | 分支、`refs/tags/x`、短/长提交号统一解析成远端引用，来源类型进入计划与报告 |
| 重命名识别 | ✅ | `src/pipeline/renames.ts`、`src/git/repository.ts`（`renamedPaths` / `renamePaths`） | 改名信息只存在于 `git diff -M<阈值> --name-status -z`（阈值 `renameThreshold`，默认 60），计划里的"删 + 增"据此折叠成一条改名；应用时两半同时进 index，提交本身就是一次真改名。阈值不足或 `--no-renames` 时仍按两条独立变更处理 |
| 删除策略 | ✅ | `src/domain/policy.ts`、`src/pipeline/plan.ts` | `mirror` 跟删、`keep` 保留、`ask` 走 `confirmDeletesPrompt` 逐次询问；`ask` 无终端或取消一律按保留处理 |
| 仓库锁 | ✅ | `src/pipeline/repo-lock.ts` | 见"关键实现选择"；`lockWaitMs` 控制等待，`doctor` 与 `status` 展示持有者 |
| 撤销上一次同步 | ✅ | `src/pipeline/undo.ts`、`--undo` | 读取状态文件里最后一条历史记录，把那次应用整体退回（新提交，不改写已推送历史）；不联网 |
| 本地缓存代理 | ❌ 已移除 | — | 缓存层已删除：同步判定直接用 blob oid，缓存不再带来收益。`cacheConfig` 等键现在会报废弃警告 |

### 冲突处理

| 功能 | 状态 | 实现位置 | 说明 |
|---|---|---|---|
| 冲突检测 | ✅ | `src/pipeline/plan.ts` | 实际产出 4 类：`content`（本地脏 + 上游要改）、`delete-modify`（上游删 + 本地脏）、`untracked-overwrite`（上游新增 + 本地未跟踪同名）、`type`（同一一路径一侧是文件一侧是目录）。`add-add`、`symlink`、`unreadable` 是 `domain/conflict.ts` 里的预留枚举，当前检测路径不会产出 |
| 三方合并 | ✅ | `src/conflict/merge.ts` | 以 merge base 为基准的行级 LCS 合并；合不动写 `<<<<<<< LOCAL` / `=======` / `>>>>>>> UPSTREAM` 标记；二进制（含 NUL）与双方删除单独降级为 `skip`；2 万行与 400 万单元格两道规模保险丝 |
| 策略引擎 | ✅ | `src/conflict/resolver.ts` | `use-source` / `keep-target` / `auto-merge` / `prompt-user` / `skip`；`autoResolveTypes` 命中的扩展名不提示，直接保留本地（不是自动合并）；`resolutionLogFile` 已声明但未被读取 |
| 交互式逐文件询问 | ✅ | `src/prompts.ts`（`conflictPrompt`） | 仅在默认策略为 `prompt-user` 且非 `-y` 时启用；取消即视为保留本地 |
| 非交互降级 | ✅ | `src/pipeline/orchestrator.ts` | `-y` + `prompt-user` 时统一按 `keep-target` 处理并给出警告，绝不卡住等待输入 |
| 决策审计 | ✅ | `conflictResolutionConfig.logResolutions` | 每条决策含路径、类型、策略、动作与原因 |

### 发布与回滚

| 功能 | 状态 | 实现位置 | 说明 |
|---|---|---|---|
| 灰度选择 | ✅ | `src/gray/selection.ts` | `percentage`（对路径做确定性 md5 分桶，重跑选同一批）、`directory`、`file` 三种策略；选择结果为空时直接报错，而不是像旧版那样停在 0% 空转 |
| 阶段机 | ✅ | `src/gray/controller.ts` | `idle → canary → validating → completed / failed / rolled-back` |
| 状态持久化 | ✅ | `src/gray/state.ts`（`.sync-gray.json`） | 记录 canary/pending 路径、基线提交、发布提交，`--full-release` 与 `--rollback` 据此执行 |
| 全量发布 | ✅ | `--full-release` | 只处理 pending 剩余路径；无活跃记录时退化为完整同步 |
| 回滚 | ✅ | `src/gray/rollback.ts` | 依据 `baseCommit` 还原被改文件、删除新增文件，生成回滚提交 |
| 校验与自动回滚 | ✅ | `src/gray/validate.ts` | `validationScript` 非 0 退出即失败；`rollbackOnFailure: true` 时自动回滚（默认 `false`） |
| 审计日志 | ✅ | `src/gray/audit.ts` | `.sync-gray-audit.jsonl` 追加式 JSONL；写失败降级为警告，不影响发布 |
| 运行监控 | 🔄 | `src/gray/monitor.ts` | 按 `monitorInterval` 采样失败率/耗时并对阈值告警，**仅输出到日志**，无外部指标系统 |

### 触发与集成

| 功能 | 状态 | 实现位置 | 说明 |
|---|---|---|---|
| Git 集成 | ✅ | `src/git/repository.ts` | 直接调用 git 子命令（`ls-tree` / `diff` / `checkout <ref> --` / `rm` / `commit --pathspec-from-file` / `push`），带统一的错误分类与脱敏 |
| 认证 | ✅ | `src/git/auth.ts`、`src/git/url.ts` | `ssh`（`GIT_SSH_COMMAND` + `IdentitiesOnly` + `BatchMode`）、`pat`、`user_pass`；带口令的私钥会明确提示改用 ssh-agent |
| 凭据脱敏 | ✅ | `redacted()` | 任何日志/错误信息里的 `user:pass@host` 都会被替换成 `***` |
| 分支策略 | ✅ | `src/pipeline/orchestrator.ts` | `feature` / `release` / `hotfix` / `develop`，`branchPattern` 支持 `{date}`、`{base}`、`{strategy}`；基准分支不存在时报错 |
| Webhook 守护 | ✅ | `src/webhook/`、`src/pipeline/webhook-mode.ts` | GitHub / GitLab / Bitbucket / Gitea，平台按请求识别；签名与事件过滤后立刻回 202，同步异步执行。生产化部分：默认只绑 `127.0.0.1`（`host`）、`port: 0` 由系统分配、TLS（`tlsCert`/`tlsKey`）、`trustProxy` 未开时不读 `x-forwarded-for`、`maxBodyBytes` 请求体上限、`GET /healthz` 存活探针（可改名或关闭）、`deduplicate` 按事件 id 去重、`deliveryLog` 追加式 JSONL 投递审计（含 `.seen.json` 侧文件）、`maxQueue`（默认 8）满时回 503 请平台重投、IP 白名单与按 IP 令牌桶限流 |
| GitOps PR 模式 | ✅ | `src/pipeline/pr.ts`、`src/pipeline/pr-cli.ts` | `prConfig` 生效时改动提交到 `branchPattern` 生成的分支并推送到 `remote`，目标分支不动；检测本机 `gh` / `glab` 等 CLI 后尝试建 PR，`create: 'never'`（`--pr-no-create`）只推分支，建不成也只输出链接不报错 |
| 失败重试 | ✅ | `src/retry.ts` | 指数退避，仅对文本命中"网络类"特征的失败重试，其余立即抛出原始错误类型 |
| 编程 API | ✅ | `src/index.ts` | `runSync` / `UpstreamSyncer` / `SyncOrchestrator` / `buildPlan` / `GrayController` / `WebhookServer` 等具名导出 |
| 通知（IM / HTTP） | ✅ | `src/notify/`、`notifyConfig` | 通道：`http` / `slack` / `dingtalk` / `wecom` / `stdout`；`event.ts` 归一化事件（成功、冲突、失败、撤销），`render.ts` 按通道渲染载荷；带自身的超时与重试，发送失败只记日志，不改变同步结果与退出码 |
| 定时同步 | 📝 | — | 未实现；交给系统 cron 或 CI 定时器 |
| 多上游仓库 | ✅ | `src/pipeline/sources.ts` | 见"同步核心"的 fan-in 条目；灰度类运行意图在多上游下被显式拒绝 |
| REST API 服务 | 📝 | — | 未实现，只有编程 API 与 webhook 接收端（外加 `/healthz` 探针） |
| 可视化仪表盘 | ❌ 已移除 | — | 旧实现里的图表/仪表盘生成模块已随重构删除 |
| AI 冲突建议、代码安全扫描、权限管理、多环境配置 | 💡 | — | 无任何代码，仅有想法 |

### 配置与诊断

| 功能 | 状态 | 实现位置 | 说明 |
|---|---|---|---|
| 多格式配置 | ✅ | `src/config/parse.ts` | JSON / JSON5 / YAML / TOML；无扩展名的 rc 文件依次按 JSON → YAML → TOML 尝试，并把每种失败原因一起报出 |
| 文件名自动发现 | ✅ | `src/config/defaults.ts`（16 个候选名） | `sync-upstream.config.*`、`sync-upstream.*`、`.sync-toolrc.*` |
| 别名与废弃键 | ✅ | `src/config/normalize.ts` | 30 余个历史写法自动改写并警告；`cache` / `cacheConfig` / `adaptiveConcurrency` 明确报废弃；未知键报"已忽略（拼写错误不会产生任何效果）" |
| 分层合并 | ✅ | `src/config/merge.ts` | 默认值 < 配置文件 < 命令行；嵌套对象按键合并，`--retry-delay` 不会抹掉文件里的 `maxRetries` |
| 聚合校验 | ✅ | `src/config/resolve.ts` | 一次报出全部问题：必填项、仓库 URL 形态、路径合法性（禁绝对路径与 `..`）、数字区间、枚举拼写、灰度/webhook 条件校验 |
| 宽松解析（诊断专用） | ✅ | `src/config/resolve.ts`（`resolveConfig(raw, { lenient })`）、`src/cli.ts` | `lenient: true` 时不抛 `ValidationError`，问题留在返回值的 `problems` 里，`config` 仍可用（坏掉的数组字段按空数组处理，避免 `.map` 崩）。只有 `status` / `doctor` / `history` 与 `--undo` 走这条路（`cli.ts` 的 `readOnly` 判定）：`runSubcommand` 把 `context.configProblems` 逐条包成 `v.lenientProblem` 进报告 `warnings`，`doctor` 另加一条 `config` 的 `fail` 检查使其成为阻塞项；`why` 与真实同步仍然严格 |
| 日志等级 | ✅ | `src/logger.ts`、`src/log/sink.ts`、`src/log/redact.ts` | `trace/debug/verbose/info/success/perf/warn/error` 单表过滤；`-V` 提升到 verbose（**不含 debug**，CLI 无入口，需库调用 `logger.setLevel(LogLevel.DEBUG)`），`-s` 只留 error；`logConfig.file` 打开落盘（`src/log/sink.ts` 的 `LogFileSink`），按 `maxBytes` 滚动、保留 `keep` 份，`json: true` 时逐行 JSON，`--log-level` 单独控制文件级别不影响控制台；写文件前统一 `scrubForFile` 脱敏，落盘失败降级为警告不影响同步 |
| 只读子命令 | ✅ | `src/commands/` | `status` / `why` / `doctor` / `history` 共用 `CommandContext` 与 `CommandReport`，`facts.ts` 负责"只读地把现状取出来"，`output.ts` 负责人类行与 `--json`（`stripAnsi` 保证真控制字符与 `\u001b` 字面量都不进 JSON），`sync-report.ts` 复用同一份报告结构给同步运行本身；带 `summary` 的报告在 `GITHUB_STEP_SUMMARY` 存在时追加一份 markdown |
| 中英双语文案 | ✅ | `src/i18n/` | 单一 `t(key, vars)` 入口 + 逐键对应的 `zh`/`en` 目录；只替换调用方确实给了的 `{占位符}`（配置文档里的 `{target}`、`{date}` 不能被吃掉），插入的值不再二次扫描；未知 key 返回 key 本身而不是空串；`joinList` 负责顿号/逗号这类语言相关的连接符 |
| 语言判定 | ✅ | `src/i18n/index.ts`（`detectLocale` / `initLocale`） | 顺序 `--lang` > `SYNC_UPSTREAM_LANG` > `LC_ALL` > `LANG` > `LANGUAGE`（冒号列表），`zh*` → 中文，其它已识别 locale → 英文，`c` / `posix` 跳过，无信号 → 中文；`main()` 第一件事就是定语言，因此模块级常量必须在导入时还不确定语言——依赖语言的文案一律写成函数或 getter |
| Shell 补全 | ✅ | `src/completion.ts`、`src/cli.ts`（`completionSource`） | 从 `parseArgs` 的同一份参数表派生 bash / zsh / fish 三种脚本；bash 分支带子命令识别与"值位不补参数"的判断，`-r <url>` 的值不会被误当成子命令 |
| 引导式 init | ✅ | `src/commands/init.ts` | 9 个问答 → 只写入回答过的 8 个键 → 先 `buildConfig` 校验再 `writeConfigFile`；`UserCancelError` 与校验失败都不落盘；`--json` / `-y` / 无 TTY 时拒绝（退出码 2） |
| 退出码 | ✅ | `src/errors.ts`（`exitCodeFor`） | 0 成功（含无变更、预览、同步流程里的 `Ctrl+C` 取消——那条走 `process.exit(0)` 而不是抛错）· 1 未预期或有文件应用失败 · 2 配置/校验或未知参数 · 3 git · 4 `UserCancelError`，只在 `src/commands/init.ts` 里抛出 · 5 `LockError`（仓库锁被占用） |

## 测试与验证方式

- 单元与集成测试在 `__tests__`，56 个测试文件；git 相关用例用临时夹具仓库（`__tests__/helpers/repo.ts`、`__tests__/helpers/sync-fixture.ts` 建真实 `git init` 仓库），端到端覆盖"上游改动 → 计划 → 应用 → 提交 → 树一致性"
- 断言里包含这类性质：同步后 `git diff <upstream-ref> HEAD -- <scope>` 必须为空；上游同内容搬家（重命名配对）时旧路径不得残留；fan-in 下两个上游各自的状态文件互不污染；锁被占用时第二次运行按 `lockWaitMs` 等待或失败，陈旧锁能被接管
- 文案层由测试守着两条性质：`zh` 与 `en` 的键集合必须逐键相同（漏一个键就红），`--lang` 切换后帮助与错误消息真的换语言（断言用 `t()` 取串，因此与开发机 `LANG` 无关）
- bash 补全脚本在 Windows 上也是真跑：把生成的脚本 source 进 Git Bash，设置 `COMP_WORDS` / `COMP_CWORD` 调用 `_sync_upstream` 后断言 `COMPREPLY`；zsh / fish 脚本只做内容校验
- 落盘、提交类验证一律用临时 git 夹具；对真实仓库（如 `J:\antdv\frontend`）只做只读 preview，比对计划与 `git diff --no-renames` 的逐路径结果，并确认目标仓库指纹（HEAD、`remote -v`、`for-each-ref`、`status`）不变
- 本机跑全量：`npx jest --coverage=false -w 1`（单跑整个套件需要 15 分钟以上，夹具套件在 Windows 上受 git 进程启动开销支配）

## 下一版候选（0.4.x）

面向用户的版本在 `docs/roadmap.md`（中英各一份，站点侧栏"下一版计划"）。下面是同一批功能点的实现落点，按建议顺序排列：

| 功能点 | 现在卡在哪 | 要做到什么程度 |
|---|---|---|
| i18n 覆盖到日志与子命令正文 | `src/i18n` 只被 `help.ts`、`errors.ts`、`commands/init.ts` 消费；`src/prompts.ts`（补全问答、冲突询问、`confirmDeletesPrompt`）、`displaySummary`、`commands/{doctor,status,why,history,sync-report}.ts` 正文、`git/repository.ts` 诊断、`retry.ts`、`pipeline/undo.ts` 的 `reason`、`gray/*`、`notify/render.ts`、`webhook/server.ts` 仍写死中文 | 同一批串进 `catalog.ts` 双语键；`src/index.ts` 导出 `setLocale` / `t` / `currentLocale` 供库调用方；现有"键集合逐键相同"测试自动覆盖新增键 |
| `--undo-to` | `pipeline/undo.ts` 只读 `newestRecord()` → `state.history[0]` | 接受 `history` 的序号或时间；先列出将改动的路径再执行；HEAD 已前进时沿用现在的拒绝文案 |
| 忽略条目自动写入 `.gitignore` | `commands/init.ts` 与 `generateDefaultConfig` 都不碰 `.gitignore`；fan-in 的 `stateFileFor()` 名字带哈希，不在内置清单里 | 生成配置与 `init` 时追加 `.sync-state*.json`（可用开关关掉），`doctor` 的 `state-ignore` 相应变绿 |
| 灰度支持多上游 | 参数校验直接拒绝 `-gr` / `-fr` / `-ro` | 选择范围按上游分组；目录重叠时输出明确清单而不是静默覆盖 |
| 凭据不落明文 | `git/url.ts` 的 `toClonableUrl` 把 `pat` / `user_pass` 拼进 remote URL 写进 `.git/config`；`git/auth.ts` 不读任何凭据环境变量 | 优先走 git credential helper，支持 `env:` 形式引用（`doctor.ts` 里那条"用 --auth-token 或环境变量提供"的误导提示已在 0.3.0 先行修掉） |
| 无 CLI 时也能建 PR | `pipeline/pr-cli.ts` 依赖本机 `gh` / `gitee`，没有就只打印对比链接 | 回退到平台 API（复用 `authConfig`），失败时仍打印链接 |
| `why` 批量 | `commands/why.ts` 取单个 `target` | 接受目录与多路径，按原因分组汇总 |
| 通知渠道补齐 | `domain/notify.ts` 的 `NotifyChannel` 只有 `stdout` / `http` / `slack` / `dingtalk` / `wecom`；`http` 无自定义头与签名 | 增加飞书渠道；`http` 支持自定义请求头与签名 |
| 内置轮询 | 自动同步只有 webhook（需可访问端口）与外部定时 | `--poll <间隔>`：按间隔拉取、无变化安静退出；附一份流水线模板 |

## 版本历史

| 版本 | 内容 |
|---|---|
| 0.1.0 | 并行处理、认证、预览模式、非交互模式，迁移到 tsup 构建 |
| 0.2.x | 灰度发布与回滚、webhook 集成、分支策略、冲突类型扩展（当时的实现） |
| 未发布（重构） | 全模块重写：改为 git 对象库判定，移除缓存/LFS/可视化，修复预览与提交不一致、`--force` 与 `--conflict-strategy` 失效、`-V` 吞日志、预览移动 HEAD、重命名删除半边丢失、灰度 0% 空转等问题；配置解析失败改为显式报错 |
| 0.3.0 | 正确性：仓库锁 + 陈旧锁接管、提交前复查锁所有权、文件 mode 与非 blob 对象、pathspec 边界、状态身份校验、死配置键清理。只读子命令 `status`/`why`/`doctor`/`history` 与 `--json`（含 `$GITHUB_STEP_SUMMARY`）。`--undo` 与同步历史。通知钩子。多上游 fan-in 与任意 ref 作为源。重命名识别 + 删除策略 + GitOps PR 模式。partial clone / 浅克隆 / 标签抓取与 LFS 感知。Webhook 生产化与日志落盘滚动。`--lang` 中英双语、shell 补全、引导式 `init`。发布：CI 矩阵 + 覆盖率阈值 + 预发布 dist-tag 规则；GitHub Pages 工作流统一 pnpm 9（lockfileVersion 9 装不上 pnpm 8），deploy 任务从 windows-latest 换成 ubuntu-latest |

## 为什么选择它

1. **可验证**：预览列出的路径 = 提交里的路径，出问题可以逐条对照
2. **可回退**：灰度阶段记录基线提交，`--rollback` 是真实还原而不是"再同步一次"
3. **低侵入**：不建临时分支、不改 `origin`、不提交别人的改动
4. **报错诚实**：配置读不到就停，参数不认识就拒，校验一次讲完
5. **可嵌入**：同一套编排逻辑既能当 CLI 用，也能通过 `runSync()` 进脚本和 CI
