# 更新日志

所有显著变更记录在此。发布版本的机器生成部分见仓库根的 [CHANGELOG.md](https://github.com/flow-zy/sync-upstream/blob/master/CHANGELOG.md)，本页补充行为层面的说明。

## [Unreleased] 全量重构

### 破坏性变更

- **移除缓存层与 LFS 专用配置**：`useCache` / `cacheDir` / `cacheConfig` / `useLFS` / `largeFileThreshold` / `lfsTrackPatterns` / `adaptiveConcurrency` 不再存在，写入只会得到废弃警告
- **移除可视化仪表盘**
- **配置格式不含 JavaScript**：支持 JSON / JSON5 / YAML / TOML，`sync.config.js`、`.sync-upstream.config.js` 之类的 JS 配置不再被读取（历史键名仍通过别名兼容）
- **命令行参数收敛**：删除 `--rm` / `--rd` / `--rb` / `--cl` / `--branch-strategy` / `--base-branch` / `--branch-pattern` 以及 `-wp` / `-wpa` / `-ws` / `-wev` / `-wb` 等别名；新增 `--ignore`、`--include-types`、`--conflict-strategy`、`--incremental`、`--strategy` / `--percentage` / `--canary-dirs` / `--file-patterns` / `--validation-script`、`--auth-*`、`-g/--generate-config`。未识别参数现在直接拒绝（退出码 2）
- **枚举值改为小写连字符**：冲突策略 `use-source` / `keep-target` / `auto-merge` / `prompt-user` / `skip`；灰度策略 `percentage` / `directory` / `file`；分支策略 `feature` / `release` / `hotfix` / `develop`
- **认证只保留 `ssh` / `pat` / `user_pass`**（此前文档承诺的 GitHub App、OIDC 从未实现）
- **`--force` 与 `--incremental` 语义明确**：前者强制应用全部变更清单，后者恢复增量判定；默认 `forceOverwrite: true`

### 行为变更

- 指定的配置文件读不到 / 无权限 / 语法坏 / 顶层不是对象 → 终止并给出原因（含每种格式的解析失败详情），不再静默回落到默认值
- 配置校验一次性列出全部问题；别名键与未识别键都会警告
- 预览（`-P` / `-n`）不再切换分支或移动 HEAD，只校验目标分支存在；但仍会新增/校正 `sync-upstream` remote 并拉取上游，完全离线时预览同样失败
- `-V` 不再吞掉普通信息级日志，并输出完整变更清单而非前 40 条
- 提交只携带本次应用的路径，不再把工作区里无关的脏文件报为变更或触发 "nothing added to commit"
- 上游同内容搬家时，同步后作用域与上游零差异，不会留下"只加了没删"的多余文件
- 灰度选择结果为空时直接报错，修掉"卡在 0% 空转"
- 上游以独立 remote `sync-upstream` 拉取，不再改写 `origin`，也不再创建临时分支 / 临时目录
- 日志与错误信息中的凭据型 URL 一律脱敏
- `branchStrategyConfig.branchPattern` 的默认值改为 `feature/sync-{date}`：此前默认 `feature/{name}` 里的 `{name}` 不是受支持占位符，只启用 `enable` 而不给 pattern 时会创建字面量含 `{name}` 的分支
- 退出码固定为 0 成功（含交互取消）/ 1 未预期或存在失败文件 / 2 配置或校验或未知参数 / 3 git 操作失败；4 是保留码，当前不会产生

### 新增

- `.sync-state.json` 支撑增量运行：上次同步过的内容自动跳过，换上游仓库或分支时自动作废重建
- 灰度发布：`.sync-gray.json` 记录进度、`.sync-gray-audit.jsonl` 记录阶段变迁；`--full-release` / `--rollback` 基于记录执行，全量发布成功后自动清理进度文件
- 冲突识别（内容 / 删除-修改 / 未跟踪覆盖 / 类型四类）与三方合并，二进制与超大文件有明确降级，不会因为"合不动"丢改动
- Webhook 守护模式：多平台签名校验、IP/CIDR 白名单、按 IP 限流、1 MiB 请求体上限、事件过滤规则、先应答后异步同步
- gitignore 语义的忽略规则（`.gitignore`、`.syncignore`、配置项、同步目录内嵌套规则，后者优先）
- `syncDirs` 支持写单个文件路径，"只同步一个文件"不需要特殊模式

### 文档

文档站定位为**纯使用指南**：只讲安装、操作、配置、排错，不再包含架构与实现说明。

- 移除架构页面（架构总览、状态文件与契约）与站点里的架构入口；面向用户的"运行产物与清理"并入[配置参考](/reference/configuration#运行产物与清理)
- 全站去掉源码路径、内部符号、数据流与设计决策类表述，改为"会怎样 / 怎么做 / 出错怎么办"
- 新增选型页 [与 fork 同步的对比](/guide/vs-fork-sync)：逐场景对比 GitHub / Gitee 自带的 "Fetch upstream"，并列出不该用本工具的场景
- 新增完整英文版文档 `docs/en/`（与中文逐页对应，站点内可切换语言）与 [README.en.md](https://github.com/flow-zy/sync-upstream/blob/master/README.en.md)
- 口径修正：冲突类型数量、`-y` 的"配置完整才零提问"规则、`-V` 不含调试日志、预览仍会拉取上游、退出码 4 为保留码、只有 `.sync-state.json` 在内置忽略清单里、`pat` / `user_pass` 的凭据会写进 `.git/config` 的 remote URL

### 可靠性

- 同步的"应用 → 提交 → 结果"全流程有端到端验证，覆盖参数映射、配置加载与别名、冲突解决、灰度选择、Webhook 校验与限流、增量基线

## [0.2.7](https://github.com/flow-zy/sync-upstream/compare/v0.2.6...v0.2.7) (2025-08-18)

- 优化缓存系统与同步流程（该缓存层已在后续重构中移除）
- 扩展冲突类型与解决策略

## [0.2.6](https://github.com/flow-zy/sync-upstream/compare/v0.2.5...v0.2.6) (2025-08-17)

- Webhook 功能增强与安全配置
- 缓存压缩、预热与按内容类型的过期策略（现均已移除）

## [0.2.5](https://github.com/flow-zy/sync-upstream/compare/v0.2.4...v0.2.5) (2025-08-16)

- 引入高级缓存系统与性能优化（现均已移除）

## [0.2.0](https://github.com/flow-zy/sync-upstream/compare/v0.1.0...v0.2.0) (2025-08-13)

### Bug Fixes

- 修复非交互式模式下的参数处理逻辑

### Features

- 添加大文件处理和本地缓存功能（现已移除）
- 为 `SyncOptions` 添加大文件和缓存相关配置

## [0.1.0](https://github.com/flow-zy/sync-upstream/compare/v0.0.2...v0.1.0) (2025-08-13)

### Features

- 添加并行处理、认证支持和预览模式功能
- 添加非交互式模式支持并迁移至 tsup 构建工具
- 添加完整的文档结构和内容
