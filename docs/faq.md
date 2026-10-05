# 常见问题

## 基础

### sync-upstream 和 `git merge upstream/main` 有什么区别？

`git merge` 合并整条分支，且冲突处理与提交都由 merge 决定。sync-upstream 的边界是**目录**：只比较、只写、只提交 `syncDirs` 里的路径，目录外的内容一概不碰。当你只想跟着上游的几个包、同时保留本地定制代码时，它比 merge 可控；当你要全盘合并时，用 merge 更直接。

### 和复制粘贴文件夹有什么区别？

复制粘贴不知道"哪些变了"，也不产生可回滚的记录。本工具基于 git 精确比较出变更集合，所以预览结果、提交内容和 `.sync-state.json` 三者始终一致，灰度还有基线提交可供 `--rollback` 使用。

### 和 GitHub / Gitee 自带的 fork 同步比，方便在哪？

先说反面：**如果只是偶尔把 fork 的默认分支整体更到上游最新，自带的 "Fetch upstream" / 同步分支更省事**（一次点击、零配置），这个工具不打算替代它。

它做的是 fork 同步做不到的那几件事：

| 场景 | 自带 fork 同步 | 本工具 |
|---|---|---|
| 只跟上游的几个目录（或一个文件） | 做不到，整分支合并 | `syncDirs` 限定范围，范围外不读不改不提交 |
| 保留本地对其他目录的定制 | 定制目录一起进 merge，冲突要你手工解 | 定制目录根本不参与；冲突文件可按策略保留本地/三方合并 |
| 确认"这次到底改了哪些文件" | 看 merge commit 的 diff | 预览打印的每条 `+`/`~`/`-` 就是提交携带的路径 |
| 大改动分批上线 | 全有或全无 | `-gr` 先发 20%，验证后 `-fr` 补齐，出问题 `-ro` 只退回发过的那批 |
| 非默认分支 / 多个分支 | 一般只针对默认分支；Gitee 在有本地独立提交时不可用 | `-c` 指定任意目标分支，可配分支策略落在 `feature/sync-{date}` 上 |
| 历史形态 | merge commit（保留上游历史与 merge 关系） | 单条同步提交（同步的是内容，不是历史） |

不适合用它的场景：需要保留上游提交历史、需要 rebase / 线性历史、需要把上游改动开成 PR 给你审、只想一键更新 fork。

带具体例子的完整对比见 [与 fork 同步的对比](/guide/vs-fork-sync)。

### 支持哪些 git / node 版本？

Node ≥ 18.2、Git ≥ 2.25。工具直接调用本机 `git`，你的代理、`insteadOf`、凭据助手配置照常生效。

## 配置

### 为什么我的配置文件没生效？

现在会有明确报错而不是静默回落：`-C` 指定的文件不存在、没权限、语法错误、内容为空、顶层不是对象，都会终止并说明原因；解析失败还会列出 JSON / YAML / TOML 各自的报错。不带 `-C` 时按固定顺序查找 16 个候选文件名，都没找到会打印一条列出查找范围的警告。

### 我写了 `targetBranch` / `maxRetries` 这类字段，工具认识吗？

认识，它们是历史别名，会自动改写为 `companyBranch` / `retryConfig.maxRetries` 并给出一次警告。别名值类型不对就是硬错误（例如 `maxRetries: "abc"`）。想完全避免别名，直接按 [配置参考](/reference/configuration) 的规范键写。

### 为什么提示 `未识别的配置项 xxx 已忽略`？

这个键不属于任何规范字段或别名，多半是拼写错误。工具不会让它静默失效，所以显式警告。

### 为什么配置报错一次只看到第一条？

不是只有一条——校验会把所有问题收集完一次性输出（`配置校验失败:` 后面逐行列出）。修完再跑会看到剩下的运行时问题，但那属于另一阶段。

### 缓存 / LFS 的配置项怎么没了？

重构后删除了缓存层与 LFS 专用配置：同步判定直接依赖 git 的比对结果，缓存不再带来收益；大文件由 git 自身传输，LFS 只需要仓库里的 `.gitattributes`。写 `cacheConfig` 之类的键现在只会收到废弃警告。

## 使用

### 怎么确认它会改哪些文件再动手？

```bash
sync-upstream -P -V    # 预览 + 完整清单
```

预览不切分支、不动工作区、不产生提交，打印出来的每条 `+` / `~` / `-` 就是提交里会出现的路径。唯一例外是它仍会新增或校正 `sync-upstream` 这个 remote 并联网拉取（会写进 `.git/config`），所以完全离线时预览也会失败。细节见 [日常同步](/guide/sync-basics#先看再动)。

### 交互式问题太多，CI 里怎么跳过？

```bash
sync-upstream -y -C sync-upstream.config.json
```

**`-y` 只在配置完整时保证零提问**：判断条件是 `!nonInteractive || 配置不完整`，而"不完整"指 `upstreamRepo` 为空或 `syncDirs` 为空——缺任一项时即使带 `-y` 也会进入补全问答。另外 `-y` 之下 `prompt-user` 冲突策略会自动降级为"保留本地"并警告，CI 里建议显式指定 `--conflict-strategy`。见 [CI 与自动化](/guide/automation#在-ci-里跑)。

### 计划显示有变更，但结果是"未提交"

两种情况：

- 计划为空 → `没有需要同步的变更，无需提交`
- 计划非空但暂存区没有差异（内容与目标分支已经一致）→ `计划中的 N 项变更未产生暂存差异，目标分支已与上游一致`

后者不是错误，重复同步同一内容时就会出现。

### 明明上游改了 100 个文件，我只同步到 90 个

看计划尾部的"跳过 … 条"：`被忽略规则排除`、`文件类型不在白名单`、`已是最新`（增量模式）、`不在同步目录内`。另外子模块指针不参与同步。想确认某个文件为何被忽略，先检查根 `.gitignore`、`.syncignore` 以及同步目录内的嵌套 `.gitignore`。

### 上游把文件搬家了，旧路径会残留吗

不会。上游把文件搬家（内容不变的重命名）时，删除的旧路径和新增的新路径都会被记录进同一次提交，旧路径不会残留。

### `.sync-state.json` 可以删吗

可以，它等价于可丢弃的增量缓存，删掉后下一次全量比对即可。也可以直接 `--force` 忽略它。换上游仓库或上游分支时文件会自动重建。落点与清理建议见 [配置参考的运行产物与清理](/reference/configuration#运行产物与清理)。

### 怎么只同步一个目录里的部分文件

`syncDirs` 决定范围，`includeFileTypes` 决定扩展名白名单，`ignorePatterns` / `.syncignore` 做排除。**只同步一个文件**不需要特殊模式：同步目录既匹配目录也匹配同名文件，所以直接把文件路径写进 `syncDirs` 就行（`"syncDirs": ["package.json"]`）。暂不支持"任意文件路径映射"（把上游 A 路径同步到本地 B 路径）。见 [单文件与局部同步](/guide/automation#单文件与局部同步)。

### 会不会把我没提交的改动一起提交上去

不会。提交只包含本次同步实际应用的路径。同步目录内如果有本地未提交改动，它们会被列为本地改动并可能被判定为冲突，但不会被顺带提交。

## 冲突

### 有哪些策略

`use-source`（采用上游）、`keep-target`（保留本地）、`auto-merge`（三方合并）、`prompt-user`（逐个询问，默认）、`skip`（跳过）。CLI 用 `--conflict-strategy`，配置文件写在 `conflictResolutionConfig.defaultStrategy`。冲突检测目前实际会产出 4 类：内容冲突、上游删除但本地有改动、需要覆盖未跟踪文件、文件类型变化，详见 [冲突处理](/guide/conflicts#会产生哪几类冲突)。

### `auto-merge` 合不动怎么办

- 双方都改且行区间交叠：写入标准冲突标记（`<<<<<<< LOCAL` / `=======` / `>>>>>>> UPSTREAM`）并暂存，需要你手工收尾
- 二进制（含 NUL 字节）：标记为跳过，不做行级合并
- 单侧删除 + 另一侧修改：判定为冲突，交回你决定
- 超过 2 万行的文件：不做逐行合并，直接输出整文件的冲突标记

### `autoResolveTypes` 是干什么的

在 `prompt-user` 下，命中的扩展名**不弹提示**，直接按保守的"保留本地"处理。它不是"这些扩展名自动合并"——那要把 `defaultStrategy` 设为 `auto-merge`。

## 灰度与回滚

### 灰度一直卡在 0% 不动

旧版本可能出现这个问题（选不出文件却继续空跑）。现在灰度选择结果为空会直接报错：`灰度选择结果为空：……请调整 percentage/canaryDirs/filePatterns`。

### `--full-release` 和 `--rollback` 依赖什么

依赖仓库根的 `.sync-gray.json`。灰度进行中不要删除它；`--full-release` 正常完成后状态会被清理。`--rollback` 需要同时启用 `grayReleaseConfig`，否则报 `--rollback 需要同时启用 grayReleaseConfig`。

### 校验脚本失败会自动回滚吗

默认不会。需要把 `grayReleaseConfig.rollbackOnFailure` 设为 `true` 才会自动回滚；否则只记录失败状态，等你显式 `--rollback`。

## Webhook

### 收到 401

三种来源：无法识别平台（缺少 `x-github-event` / `x-gitea-event` / `x-gitlab-event`|`x-gitlab-token` / `x-event-key`，且 `supportedPlatforms` 不止一个平台）、签名缺失或格式不对、签名不匹配。secret 为空时**所有请求都会被拒**，这是有意设计。

### 403 / 429 / 413

`403` IP 不在 `securityConfig.ipWhitelist`；`429`（或你配置的 `statusCode`）表示请求超出限流速率；`413` 请求体超过 1 MiB。

### 200 但没触发同步

响应体里有 `reason`：`非触发分支: xxx` 或 `事件不在允许列表: xxx`，或事件过滤规则未命中。分支比较用的是去掉 `refs/heads/` 的短名。三层过滤的判定顺序见 [事件过滤](/guide/webhook#事件过滤)。

### 同步失败会不会让服务退出

不会。服务先返回 `202 { accepted: true }`，同步在后台跑，失败只写日志。

### 能不能从环境变量读 secret

不能，工具**不读任何环境变量**。`webhookConfig.secret` 必须是配置里的值，或由 CI/shell 展开成 `--webhook-secret "$SYNC_WEBHOOK_SECRET"`。写在仓库里的配置文件请保证不含真实密钥。

### 前面有反向代理，IP 白名单和限流按什么算

按 `x-forwarded-for` 的第一跳判定（没有该头时用连接的远端地址）。该头由客户端可控，公网直接暴露时可以被伪造——白名单只应作为纵深防御，前置代理需要负责覆写这个头。

## 故障排查

### 常见报错怎么读

| 报错 | 处理 |
|---|---|
| `Not a git repository` | 当前目录 `git init` |
| `上游分支 x 在 <redacted url> 中不存在` | 确认分支名；日志里的 URL 已脱敏 |
| `目标分支 x 既不在本地也不在 origin，请先创建后重试` | 预览模式不会替你建分支，先确认分支名 |
| `认证失败，请检查仓库权限或 --auth 配置` | 检查 token 权限 / 私钥；带口令的私钥请先交给 ssh-agent |
| `工作区存在未提交改动，git 拒绝了本次操作` | 先提交或暂存本地改动（尤其冲突文件） |
| `推送到 origin/xxx 失败` | 提交已在本地，检查权限与分支保护后可单独 `git push` |

### 退出码含义

`0` 成功（含"无变更"、预览运行、以及交互里按 `Ctrl+C` 取消）· `1` 未预期错误或有文件应用失败 · `2` 配置/校验失败或未知命令行参数 · `3` git 操作失败 · `4` 对应用户取消，属**保留码**：取消路径当前直接以 `0` 结束，脚本观测不到 4。分类见 [CI 与自动化](/guide/automation#退出码)。

### 怎么看详细日志

```bash
sync-upstream -V    # verbose 级别 + 完整变更清单
sync-upstream -s    # 只保留错误输出
```

`-V` 把级别设为 verbose：计划不再截断到 40 条，verbose 级信息放行。它**不包含 debug**——目前唯一的 debug 输出是逐条 `冲突已解决: 路径 → 动作`，命令行没有开关能降到该级别，只有以库方式使用时才看得到。`-V` 与 `-s` 同时给时 `-V` 生效。日志仅输出到控制台，工具不写日志文件。见 [日志](/guide/automation#日志)。

### 出问题后想干净重来

1. `git status` 看工作区（工具提交后仍可能有冲突标记文件待你处理）
2. `git log -1 --stat` 看那次同步提交到底带了哪些路径
3. 需要撤销：`git reset --hard HEAD~1`（自己确认清楚再执行），灰度场景优先用 `sync-upstream -gr --rollback`
4. 可选：删除 `.sync-state.json` 后 `--force` 重跑

### 会不会动我的 `origin`

不会。上游以名为 `sync-upstream` 的独立 remote 添加（`git remote -v` 能看到），引用落在 `refs/remotes/sync-upstream/<branch>`。推送目标是 `companyBranch` 跟踪的上游，缺省 `origin/<branch>`。

### token 存在哪里

日志和报错里的 URL 一律脱敏（`//user:pass@host` → `//***@host`），但**使用 `--auth-type pat` 或 `user_pass` 时，凭据会随 remote URL 写进 `.git/config`**——这是 git 自身的凭据方式，不是工具额外加的。共享机器或会把 `.git/config` 打包外传（某些 CI 缓存、`git bundle`）的场景请改用 `ssh`（走 `GIT_SSH_COMMAND`，不落凭据）或凭据助手，用完可 `git remote remove sync-upstream`。
