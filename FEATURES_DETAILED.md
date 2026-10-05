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
| 大文件 / LFS | 🔄 | — | 二进制内容直接由 git 传输，无需特判；但**不再提供**旧的 `useLFS` / `largeFileThreshold` 配置，LFS 依赖仓库自身的 `.gitattributes` |
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
| Webhook 守护 | ✅ | `src/webhook/`、`src/pipeline/webhook-mode.ts` | GitHub / GitLab / Bitbucket / Gitea；签名与事件过滤后立刻回 202，同步异步执行 |
| 失败重试 | ✅ | `src/retry.ts` | 指数退避，仅对文本命中"网络类"特征的失败重试，其余立即抛出原始错误类型 |
| 编程 API | ✅ | `src/index.ts` | `runSync` / `UpstreamSyncer` / `SyncOrchestrator` / `buildPlan` / `GrayController` / `WebhookServer` 等具名导出 |
| 定时同步 | 📝 | — | 未实现；交给系统 cron 或 CI 定时器 |
| 多上游仓库 | 📝 | — | 一次运行仍对应一个上游；多上游用多个配置文件分别跑 |
| 通知（邮件 / IM） | 📝 | — | 未实现 |
| REST API 服务 | 📝 | — | 未实现，只有编程 API 与 webhook 接收端 |
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
| 日志等级 | ✅ | `src/logger.ts` | `trace/debug/verbose/info/success/perf/warn/error` 单表过滤；`-V` 提升到 verbose（**不含 debug**，CLI 无入口，需库调用 `logger.setLevel(LogLevel.DEBUG)`），`-s` 只留 error；日志只出控制台，不写文件 |
| 退出码 | ✅ | `src/errors.ts`（`exitCodeFor`） | 0 成功（含无变更、预览、交互取消）· 1 未预期或有文件应用失败 · 2 配置/校验或未知参数 · 3 git · 4 是 `UserCancelError` 的映射值，属保留码（取消当前走 `process.exit(0)`） |

## 测试与验证方式

- 单元与集成测试在 `__tests__/`，19 个套件；git 相关用例用临时夹具仓库（`__tests__/helpers/repo.ts` 建真实 `git init` 仓库），端到端覆盖"上游改动 → 计划 → 应用 → 提交 → 树一致性"
- 断言里包含这类性质：同步后 `git diff <upstream-ref> HEAD -- <scope>` 必须为空；上游同内容搬家（重命名配对）时旧路径不得残留
- 覆盖真实仓库只做只读校验：预览计划与 `git diff --no-renames` 的逐路径结果一致，且目标仓库指纹（HEAD、`remote -v`、`for-each-ref`、`status`）保持不变

## 版本历史

| 版本 | 内容 |
|---|---|
| 0.1.0 | 并行处理、认证、预览模式、非交互模式，迁移到 tsup 构建 |
| 0.2.x | 灰度发布与回滚、webhook 集成、分支策略、冲突类型扩展（当时的实现） |
| 未发布（重构） | 全模块重写：改为 git 对象库判定，移除缓存/LFS/可视化，修复预览与提交不一致、`--force` 与 `--conflict-strategy` 失效、`-V` 吞日志、预览移动 HEAD、重命名删除半边丢失、灰度 0% 空转等问题；配置解析失败改为显式报错 |

## 为什么选择它

1. **可验证**：预览列出的路径 = 提交里的路径，出问题可以逐条对照
2. **可回退**：灰度阶段记录基线提交，`--rollback` 是真实还原而不是"再同步一次"
3. **低侵入**：不建临时分支、不改 `origin`、不提交别人的改动
4. **报错诚实**：配置读不到就停，参数不认识就拒，校验一次讲完
5. **可嵌入**：同一套编排逻辑既能当 CLI 用，也能通过 `runSync()` 进脚本和 CI
