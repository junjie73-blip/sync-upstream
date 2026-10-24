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

不适合用它的场景：需要保留上游提交历史、需要 rebase / 线性历史、只想一键更新 fork。想"改动先变成 PR 给你审、目标分支不动"的话，现在有能力覆盖：`--pr` 会把同步提交推到一个自动生成的分支并产出 PR，见 [配置参考 prConfig](/reference/configuration#prconfig)。

带具体例子的完整对比见 [与 fork 同步的对比](/guide/vs-fork-sync)。

### 支持哪些 git / node 版本？

Node ≥ 18.2、Git ≥ 2.25。工具直接调用本机 `git`，你的代理、`insteadOf`、凭据助手配置照常生效。

## 配置

### 配置文件从哪开始写？

两条路。`sync-upstream init` 只问决定同步结果的几项（上游地址、分支、目标分支、同步目录等），把答案写成一个小到能读完的文件；目标文件已存在时要 `--force` 才覆盖，`--json` 或 `-y` 之下会直接拒绝。想要整份默认模板就用 `-g, --generate-config`，格式由 `-F, --config-format json|json5|yaml|toml` 指定。

### 为什么我的配置文件没生效？

现在会有明确报错而不是静默回落：`-C` 指定的文件不存在、没权限、语法错误、内容为空、顶层不是对象，都会终止并说明原因；解析失败还会列出 JSON / YAML / TOML 各自的报错。不带 `-C` 时按固定顺序查找 16 个候选文件名，都没找到会打印一条列出查找范围的警告。

### 我写了 `targetBranch` / `maxRetries` 这类字段，工具认识吗？

认识，它们是历史别名，会自动改写为 `companyBranch` / `retryConfig.maxRetries` 并给出一次警告。别名值类型不对就是硬错误（例如 `maxRetries: "abc"`）。想完全避免别名，直接按 [配置参考](/reference/configuration) 的规范键写。

### 为什么提示 `未识别的配置项 xxx 已忽略`？

这个键不属于任何规范字段或别名，多半是拼写错误。工具不会让它静默失效，所以显式警告。

### 为什么配置报错一次只看到第一条？

不是只有一条——校验会把所有问题收集完一次性输出（`配置校验失败:` 后面逐行列出）。修完再跑会看到剩下的运行时问题，但那属于另一阶段。

### 缓存的配置项怎么没了？LFS 还有配置吗？

缓存层已经删除：增量判定直接用 git 记录的内容哈希，状态文件本身就是判定依据，单独一层缓存不再带来收益。`cache`、`cacheConfig`、`adaptiveConcurrency` 写了也不会静默失效——会收到一次"已废弃并被忽略"的警告并说明现在靠什么（并发数只由 `concurrencyLimit` 决定）。

LFS 又有了独立配置，但不是老名字：`fetchConfig.lfs` 取 `pointer`（默认，只同步指针文本）、`materialize`（写完指针再用 git-lfs 回取真实内容，需要本机装好且上游 LFS 服务可用）、`off`（完全不检测）。大文件传输本身仍由 git 负责，靠仓库里的 `.gitattributes`。同一节里还有 `filter`（部分抓取）与 `depth`，见 [配置参考 fetchConfig](/reference/configuration#fetchconfig)。

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

**`-y` 只在配置完整时保证零提问**：判断条件是 `!nonInteractive || 配置不完整`，而"不完整"指 `upstreamRepo` 为空或 `syncDirs` 为空——缺任一项时即使带 `-y` 也会进入补全问答。想连这种情况也不提问，加 `--json`：机器输出模式禁止问答，会强制非交互，配置不全就直接失败而不是干等输入。另外 `-y` 之下 `prompt-user` 冲突策略会自动降级为"保留本地"并警告，CI 里建议显式指定 `--conflict-strategy`。见 [CI 与自动化](/guide/automation#在-ci-里跑)。

### 计划显示有变更，但结果是"未提交"

两种情况：

- 计划为空 → `没有需要同步的变更，无需提交`
- 计划非空但暂存区没有差异（内容与目标分支已经一致）→ `计划中的 N 项变更未产生暂存差异，目标分支已与上游一致`

后者不是错误，重复同步同一内容时就会出现。

### 明明上游改了 100 个文件，我只同步到 90 个

先看计划尾部的"跳过 … 条"，每条都有名字：`被忽略规则排除`、`文件类型不在白名单`、`不在同步目录内`、`已是最新`（增量模式）、`子模块（gitlink）无法按文件同步`、`上游删除但被删除策略保留`、`本地 core.symlinks=false，符号链接未写入`。想知道**单个文件**的判定，别猜——`sync-upstream why <路径>` 会用真实计划同一次比对的结果回答，结论只有五种：`会同步`、`需要冲突处理`、`不会同步`（附命中了哪条忽略规则及它的来源文件）、`已与上游一致`、`未找到该文件`；加 `--fetch` 先拉上游，加 `--json` 给机器读。整体状态看 `sync-upstream status`（跳过原因按数量汇总），环境是否可用看 `sync-upstream doctor`。

### 上游把文件搬家了，旧路径会残留吗

默认不会。改名识别开着（`renameDetection: true`，相似度门槛 `renameThreshold: 60`，就是 git 的 `--find-renames`）时，旧路径和新路径作为同一次改名落进同一条提交，预览里显示为 `>` 并带相似度百分比，旧路径不会残留。

改名识别在这几种情况下会被关掉并给出警告：`--no-renames` 显式关闭、`deletePolicy: 'keep'`、灰度进行中、`fetchConfig.depth` 设了浅抓取。这时搬家按"上游删除 + 上游新增"两条处理，新增照常同步，旧路径是否删掉就由删除策略决定——`mirror`（默认）删，`keep` 保留并把它记为 `上游删除但被删除策略保留`，`ask` 在打印计划后逐个问你。见 [配置参考 删除与改名](/reference/configuration#删除与改名)。

### `.sync-state.json` 可以删吗

可以，它等价于可丢弃的增量缓存：删掉后下一次比对就是全量的（默认 `forceOverwrite: true` 本来也不用它跳过文件，只有 `--incremental` / `"forceOverwrite": false` 才依据它跳过）。换上游仓库或上游分支时文件会自动重建。唯一代价是文件里还记着最近若干次同步的提交（上限 50 条），删了就等于 `sync-upstream history` 没有内容、`-uo` 也找不到可撤销的记录，所以想保留撤销能力就先别删。落点与清理建议见 [配置参考的运行产物与清理](/reference/configuration#运行产物与清理)。

### 怎么只同步一个目录里的部分文件

`syncDirs` 决定范围，`includeFileTypes` 决定扩展名白名单，`ignorePatterns` / `.syncignore` 做排除。**只同步一个文件**不需要特殊模式：同步目录既匹配目录也匹配同名文件，所以直接把文件路径写进 `syncDirs` 就行（`"syncDirs": ["package.json"]`）。暂不支持"任意文件路径映射"（把上游 A 路径同步到本地 B 路径）。见 [单文件与局部同步](/guide/automation#单文件与局部同步)。

### 会不会把我没提交的改动一起提交上去

不会。提交只包含本次同步实际应用的路径。同步目录内如果有本地未提交改动，它们会被列为本地改动并可能被判定为冲突，但不会被顺带提交。

### 能不能同时跑两个同步

不能并行，但也不会互相踩到：仓库根的 `.git` 下有一把 `.git/sync-upstream.lock`，第二个进程默认（`lockWaitMs: 0`）立刻以 `5` 号退出码报错并说明持有者的 pid、任务名和开始时间。想让第二个排队，给 `lockWaitMs` 或 `--lock-wait <ms>`；webhook 守护模式本身就是靠这把锁把投递串起来的。残留的锁会自动接管：持有进程已退出时立即接管，进程还在但锁超过 30 分钟才接管（pid 被复用或跨机器 pid 空间的情况）。不确定状态就跑 `sync-upstream doctor`，它会列出「仓库锁被占用」还是「仓库锁空闲」。

### 想同时跟多个上游怎么办

用 `upstreams: [{ repo, branch, dirs, message }]`，也就是 fan-in：每个上游各有自己的抓取远程（`sync-upstream`、`sync-upstream-2`…）、自己的增量状态文件和自己的那条同步提交，目录重叠时按数组顺序后者覆盖前者。命令行上重复 `-r` / `-b` 是同一件事的简写。没写的字段继承顶层配置，而这个列表一旦存在就取代顶层的 `upstreamRepo` / `upstreamBranch`。限制：多上游与灰度发布互斥（`-gr` / `-fr` / `-ro` 会直接报错），各源的状态文件名带引用与哈希、不在内置忽略清单里，建议把 `.sync-state-*.json` 加进 `.gitignore`。见 [配置参考 upstreams](/reference/configuration#多上游-upstreams)。

### 上游仓库很大，抓取太慢太占磁盘

抓什么由 `fetchConfig` 决定：`filter: 'blob'` 走部分抓取，不下载文件内容对象；`filter: 'tree'` 连目录对象也按需；`depth: n` 只取最近 n 个提交（会把本地仓库变浅，同时会关掉改名识别）；`tags` 默认不带标签；上游用 Git LFS 时 `lfs` 取 `pointer`（默认只同步指针文本）/ `materialize`（再用 git-lfs 回取真实内容，需要本机装好且 LFS 服务可用）/ `off`（完全不检测）。命令行对应 `--fetch-filter` / `--fetch-depth` / `--fetch-tags` / `--lfs`。见 [配置参考 fetchConfig](/reference/configuration#fetchconfig)。

### 同步提交能撤销吗

能，两种用法。`sync-upstream history` 列出状态文件里记录的最近几次同步（默认 10 条，`--limit` 调整，`--json` 给机器读）；`sync-upstream -uo`（`--undo`）撤销最近一次记录的同步——用 `git revert` 生成一条新的撤销提交，不改写历史，所以已推送的分支也能安全回退。它只在记录的那条提交仍然是 HEAD 时动手；如果上面又叠了你自己的提交，只会打印 `请手工执行 git revert <commit>` 而不猜测你的意图。撤销成功后会顺手忘掉这些文件的路径，下次同步重新比对，不会被增量状态骗过去。注意 PR 模式不读写增量状态，那次运行不会留下可供 `-uo` 回退的记录——改动只在新分支上，丢弃分支或关掉 PR 即可。

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

依赖仓库根的 `.sync-gray.json`。灰度进行中不要删除它；`--full-release` 正常完成后状态会被清理。`--rollback` 需要同时启用 `grayReleaseConfig`，否则报 `--rollback 需要同时启用 grayReleaseConfig`。多上游 fan-in（`upstreams`）与灰度互斥，带 `upstreams` 时用 `-gr` / `-fr` / `-ro` 会直接报错，需要灰度就一次只配一个上游。

### 校验脚本失败会自动回滚吗

默认不会。需要把 `grayReleaseConfig.rollbackOnFailure` 设为 `true` 才会自动回滚；否则只记录失败状态，等你显式 `--rollback`。

## Webhook

### 收到 401

三种来源：无法识别平台（缺少 `x-github-event` / `x-gitea-event` / `x-gitlab-event`|`x-gitlab-token` / `x-event-key`，且 `supportedPlatforms` 不止一个平台）、签名缺失或格式不对、签名不匹配。secret 为空时**所有请求都会被拒**，这是有意设计。

### 403 / 413 / 429 / 503 / 405 / 404

- `403`：来源 IP 不在 `webhookConfig.securityConfig.ipWhitelist`
- `413`：请求体超过上限，默认 1 MiB，可用 `webhookConfig.maxBodyBytes` 调整（最小 1024 字节）
- `429`：超出限流速率（状态码可被 `webhookConfig.securityConfig.rateLimit.statusCode` 改写）
- `503`：后台同步队列已满（`webhookConfig.maxQueue`，默认 8）或服务正在退出。这是给平台的重投信号，不是配置错误
- `405`：非 POST 方法
- `404`：路径既不是 `webhookConfig.path`，也不是健康检查端点（默认 `/healthz`，`healthPath: false` 可关闭）

### 200 但没触发同步

响应体里有 `reason`：`非触发分支: xxx`、`事件不在允许列表: xxx`、事件过滤规则未命中，或者 `重复投递: xxx`——provider 用同一个 delivery id 重发时，第二次只确认不再同步一遍（`deduplicate` 默认开启，可关掉）。分支比较用的是去掉 `refs/heads/` 的短名。三层过滤的判定顺序见 [事件过滤](/guide/webhook#事件过滤)。

### 同步失败会不会让服务退出

不会。服务先返回 `202 { accepted: true }`，同步在后台跑，失败只写日志。设置了 `webhookConfig.deliveryLog` 时，失败还会在投递审计里追加一条 `decision` 为 `failed` 的 JSONL 记录，进程退出后依旧能回看；`sync-upstream doctor` 会读出最近一条告诉你服务确实在收投递。

### 前面有反向代理，IP 白名单和限流按什么算

默认只按**连接的远端地址**判定——代理前面那跳，也就是代理自己的 IP。`x-forwarded-for` 的首跳要显式打开 `webhookConfig.trustProxy: true` 才会被采纳，因为那个头是客户端可控的，直接暴露到公网时可以伪造。所以正确姿势是：保持默认的 `host: 127.0.0.1` 只让本机代理访问，在代理里覆写 `x-forwarded-for`，然后才打开 `trustProxy`；白名单始终只作为纵深防御，别当唯一闸门。`sync-upstream doctor` 会提示这些组合：对外监听却没配 `ipWhitelist`（警告）、`trustProxy=true`（提示它会参与白名单与限流判断）、非回环地址且没有 `tlsCert/tlsKey`（警告）。

### 能不能从环境变量读 secret

不能，凭据**一律不从环境变量读取**：`webhookConfig.secret` 要么是配置里的值，要么由 CI/shell 展开成 `--webhook-secret "$SYNC_WEBHOOK_SECRET"`。写在仓库里的配置文件请保证不含真实密钥。

工具会读这几个非敏感的环境变量，只是行为开关，不含任何凭据：`SYNC_UPSTREAM_LANG`（配合 `LC_ALL` / `LANG` / `LANGUAGE` 决定输出语言，等价于 `--lang`）、`GITHUB_STEP_SUMMARY`（存在时把结果摘要追加写进去）、`SYNC_UPSTREAM_PR_CREATE=0`（关掉 PR 模式的自动创建）。

## 故障排查

### 常见报错怎么读

| 报错 | 处理 |
|---|---|
| `Not a git repository` | 当前目录 `git init` |
| `上游分支 x 在 <redacted url> 中不存在` | 确认分支名；日志里的 URL 已脱敏 |
| `目标分支 x 既不在本地也不在 origin，请先创建后重试` | 预览模式不会替你建分支，先确认分支名 |
| `认证失败，请检查仓库权限或 --auth 配置` | 检查 token 权限 / 私钥；带口令的私钥请先交给 ssh-agent |
| `工作区存在未提交改动，git 拒绝了本次操作` | 先提交或暂存本地改动（尤其冲突文件） |
| `仓库正被另一次同步占用（pid …，任务 …，开始于 …）。等待 Nms 后放弃；确认没有其它进程后可删除 … 强制解锁` | 同一仓库同时只能有一个同步。要么等它结束，要么用 `--lock-wait <ms>` / `lockWaitMs` 排队；持有者已退出时会自动接管，进程还活着但确实是残留文件时才手工删 `.git/sync-upstream.lock`。`sync-upstream doctor` 能看出是谁占着 |
| `推送到 origin/xxx 失败` | 提交已在本地，检查权限与分支保护后可单独 `git push` |

### 退出码含义

`0` 成功（含"无变更"、预览运行、以及同步流程里按 `Ctrl+C` 取消）· `1` 未预期错误或有文件应用失败 · `2` 配置/校验失败或未知命令行参数 · `3` git 操作失败 · `4` 用户取消（当前只有 `sync-upstream init` 里取消会返回它，同步流程的取消仍以 `0` 结束）· `5` 仓库被另一次同步占用。分类见 [CI 与自动化](/guide/automation#退出码)。

### 怎么看详细日志

```bash
sync-upstream -V          # verbose 级别 + 完整变更清单
sync-upstream --debug     # 再降一级，含逐条冲突决策等细节
sync-upstream -s          # 只保留错误输出
```

`-V` 把级别设为 verbose：计划不再截断到 40 条，verbose 级信息放行；`--debug` 比它更细，是命令行专属开关，配置文件里没有对应键（不会某天被一份配置意外打开）。`-s` 优先级最高，`-V` 次之。

想留证据就落盘：`--log-file <路径>` 或 `logConfig.file` 会把日志同时写进文件，可用 `--log-level`（默认 `info`，想收 debug 行就填 `debug`）、`--log-json`（每行一个 JSON 对象）、`--log-max`（默认 5 MiB）、`--log-keep`（默认留 5 份轮转文件）调节；写进文件的行会先去掉颜色码，再把 URL 里的账号口令、`token=` / `secret=` / `Bearer` 这类值打码。控制台级别与文件级别互相独立。见 [日志](/guide/automation#日志) 与 [配置参考 logConfig](/reference/configuration#logconfig)。

### 出问题后想干净重来

1. `git status` 看工作区（工具提交后仍可能有冲突标记文件待你处理）
2. `git log -1 --stat` 看那次同步提交到底带了哪些路径
3. 需要撤销：优先 `sync-upstream -uo`，它生成一条 revert 提交、不改写历史，已推送也安全；只有确认这条同步提交还只在本地时才用 `git reset --hard HEAD~1`。灰度场景用 `sync-upstream -gr --rollback`
4. 可选：删除 `.sync-state.json` 后重跑（下一次本来就是全量比对），代价是丢掉 `history` / `-uo` 依赖的同步记录

### 会不会动我的 `origin`

不会。上游以名为 `sync-upstream` 的独立 remote 添加（`git remote -v` 能看到），引用落在 `refs/remotes/sync-upstream/<branch>`。推送目标是 `companyBranch` 跟踪的上游，缺省 `origin/<branch>`。

### token 存在哪里

日志和报错里的 URL 一律脱敏（`//user:pass@host` → `//***@host`），但**使用 `--auth-type pat` 或 `user_pass` 时，凭据会随 remote URL 写进 `.git/config`**——这是 git 自身的凭据方式，不是工具额外加的。共享机器或会把 `.git/config` 打包外传（某些 CI 缓存、`git bundle`）的场景请改用 `ssh`（走 `GIT_SSH_COMMAND`，不落凭据）或凭据助手，用完可 `git remote remove sync-upstream`。
