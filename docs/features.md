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
- **注意**：基线记在 `.sync-state.json`，换上游仓库或分支时自动作废重建，删掉也安全
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

## 触发与集成

### 认证
- **能做什么**：私有仓库读取，三种方式：`ssh` / `pat` / `user_pass`
- **怎么用**：`--auth-type` 加对应凭据参数，或写 `authConfig`；不给 `--auth-type` 时其余认证字段不生效
- **注意**：日志与报错里的 URL 一律脱敏；`pat` / `user_pass` 会把凭据写进 `.git/config` 的 remote URL，别把该文件贴出去
- **文档**：[私有仓库认证](/guide/quick-start#私有仓库认证) · [参数组的行为边界](/reference/cli#参数组的行为边界)

### 分支策略
- **能做什么**：在派生分支上完成同步，方便评审后再合回
- **怎么用**：`branchStrategyConfig.enable: true`，`strategy` 取 `feature` / `release` / `hotfix` / `develop`，`branchPattern` 默认 `feature/sync-{date}`（支持 `{date}`、`{base}`、`{strategy}`）
- **注意**：只在真实运行生效，预览不切分支；基准分支不存在直接报错；`autoSwitchBack` 与 `autoDeleteMergedBranches` 是**当前版本没有行为**的保留字段
- **文档**：[分支策略](/guide/sync-basics#分支策略)

### Webhook 守护模式
- **能做什么**：常驻接收上游事件，符合条件就触发一次同步
- **怎么用**：`-we`，配 `--webhook-port` / `--webhook-path` / `--webhook-secret` / `--webhook-events` / `--webhook-branch`
- **注意**：支持 GitHub / GitLab / Bitbucket / Gitea；secret 为空时任何请求都被拒（401）；请求体上限 1 MiB；先应答再后台同步，后台失败只记日志不会回传给上游
- **文档**：[Webhook 守护模式](/guide/webhook) · [请求处理的顺序](/guide/webhook#请求处理的顺序)

### 失败重试
- **能做什么**：网络抖动导致的上游拉取失败自动退避重试，其他错误立即抛出
- **怎么用**：`retryConfig` / `--retry-max` `--retry-delay` `--retry-backoff`
- **注意**：重试只作用于拉取上游这一步，应用与提交阶段失败不重试（重跑整条命令即可）
- **文档**：[并发与重试](/guide/automation#并发与重试)

### 日志与退出码
- **能做什么**：分级日志与可分流的退出码，便于脚本判断
- **怎么用**：`-V` 更详细、`-s` 只留错误；`0` 成功（含无变更与预览）、`1` 有失败文件、`2` 配置或参数问题、`3` git 操作失败
- **注意**：`-V` 不会打开最底层的调试日志；退出码 `4` 是保留值，当前不会产生
- **文档**：[日志](/guide/automation#日志) · [退出码](/guide/automation#退出码) · [日志与错误](/reference/api#日志与错误)

## 不支持（避免误解）

- 不改写你的 `origin`，只维护名为 `sync-upstream` 的专属 remote
- 不同步子模块指针
- 不保留上游提交历史：同步的是内容，不是 commit
- 不做 Git LFS 专门处理、定时任务、可视化仪表盘
- 不读取任何环境变量：配置与凭据只能来自配置文件与命令行
- 未实现：多上游仓库、邮件/IM 通知、HTTP API、冲突自动建议、许可证扫描、权限管理、多环境配置

## 相关页面

- [使用总览](/guide/usage)：按任务找文档
- [常见问题](/faq)：报错与行为疑问
- [更新日志](/changelog)：版本间变更
