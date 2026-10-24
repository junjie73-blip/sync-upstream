# 日常同步

覆盖一次同步里最常碰到的事：预览、交互、应用与提交边界、并发锁、重命名与删除策略、多上游、分支策略、撤销与同步记录。冲突、灰度、webhook、CI 各自单独成页，见 [使用总览](/guide/usage)。

## 先看再动

```bash
sync-upstream -P            # 预览：不修改工作区、不切分支、不提交
sync-upstream -n            # 同上，脚本习惯用 dry-run
sync-upstream -P -V         # 预览并列出全部变更路径（默认只显示前 40 条）
```

计划输出形如：

```text
计划: 163 项变更 (源 sync-upstream/main → 目标 company/main)
+ packages/shared/src/new-file.ts (packages/shared)
~ packages/runtime-core/src/index.ts (packages/runtime-core)
> packages/shared/src/old-name.ts → packages/shared/src/new-name.ts 相似度 92% (packages/shared)
- packages/shared/src/dropped.ts (packages/shared)
冲突: 2 个文件本地与上游都有改动
  ! packages/shared/src/const.ts [content]
跳过 7 个文件 — 被忽略规则排除
本地已修改文件 3 个（仅同步目录内）
```

`+` 新增、`~` 修改、`-` 删除、`>` 重命名（旧路径 → 新路径，附相似度）；括号里是命中的同步范围（`syncDirs` 项，可以是目录或单个文件）。默认最多打印 40 条，`-V` 打印全部。跳过原因有下面几类：

| 原因 | 打印文案 | 触发条件 |
|---|---|---|
| `ignored` | 被忽略规则排除 | 命中内置忽略、`.gitignore`、`.syncignore`、`ignorePatterns` 或目录级 `.gitignore` |
| `file-type` | 文件类型不在白名单 | 设了 `includeFileTypes` 且扩展名不在列表内 |
| `already-synced` | 已是最新 | 增量模式（`forceOverwrite: false` / `--incremental`）下，该文件的上游内容与 `.sync-state.json` 里的记录一致，没有新变化 |
| `outside-sync-dirs` | 不在同步目录内 | 范围外的文件不会进入计划，此项一般不会出现在输出中，仅用于诊断 |
| `submodule` | 子模块（gitlink）无法按文件同步 | 该路径在某一侧是子模块指针，文件级同步无法表达，需在目标仓库手动 `git submodule add/update` |
| `symlink-unsupported` | 本地 core.symlinks=false，符号链接未写入 | 本仓库没开启符号链接（Windows 未启用开发者模式时的默认值），检出符号链接只会写出一个存目标的文本文件 |
| `delete-protected` | 上游删除但被删除策略保留 | `deletePolicy` 为 `keep`，或 `ask` 时选择了保留，见 [上游删除怎么办](#上游删除怎么办) |

预览与真实运行使用同一份计划：预览看到的每一条变更都会出现在提交里，反之提交也不会带上预览里没出现过的文件（按冲突决策保留本地的除外）。

## 交互模式

不带 `-y` 时，工具会先补齐 `upstreamRepo`、`syncDirs`、`upstreamBranch`、`companyBranch`、`commitMessage` 中未设置的项，然后固定追问 5 个可选项：是否推送、是否预览、失败重试并发数、冲突处理方式，最后确认开始。

要点：

- **`-y` 不等于"绝对不问"**：只要 `upstreamRepo` 或 `syncDirs` 有一项为空，即使加了 `-y` 仍会提问——CI 里请把这两项写进配置文件或用 `-r`/`-d` 传齐
- 对 `确认开始同步?` 回答"否"等同于取消
- 按 `Ctrl+C` 取消会打印"操作已取消"并以退出码 **0** 结束，不算失败
- 单个冲突文件的提问里按 `Ctrl+C` 不会中断整个流程，该文件按"保留本地"处理
- `-y` 之下，`prompt-user` 冲突策略自动降级为"保留本地"并给出警告，绝不会挂在等待输入上

```bash
sync-upstream -y -C sync-upstream.config.json --push
```

## 真实同步

```bash
sync-upstream                       # 用配置文件里的设置执行
sync-upstream -p                    # 额外推送
sync-upstream --conflict-strategy auto-merge
```

应用结果一行汇总：

```text
应用完成: 160 个文件写入, 2 个保留本地, 1 个失败
  x packages/shared/src/blocked.ts: ...原因...
```

提交行：

```text
已提交 1a2b3c4d（163 个文件）
```

括号里是本次提交携带的**文件数**，与 `git status` 里的脏文件计数无关。若计划非空但最终没有产生暂存差异，会输出"未提交: 计划中的 N 项变更未产生暂存差异，目标分支已与上游一致"——这不是错误，重复运行同内容时就会出现。看到"计划有变更但未提交"只有两种情况：目标分支内容已经等于上游，或这些路径被冲突决策留在了本地。

推送目标取自目标分支跟踪的上游分支；没有跟踪信息时回落到 `origin` 上的同名分支，仓库里连 `origin` 都没有时直接报错。推送失败会保留本地提交并报退出码 3，你可以单独 `git push`。一个需要留意的边界：如果目标分支跟踪的上游被设成了 `sync-upstream` 这个 remote，`-p` 就会往上游仓库推——公司分支请保持跟踪 `origin`。

## 同一个仓库同时只能跑一次

两次同步共用一个工作区会互相踩踏：`checkout`、`git rm`、索引写入和提交交错进行，最后两个进程都提交了谁也没计划过的内容。最常见的触发方式是 webhook 投递了一次、有人又手工跑了一次。所以每次运行都会先取得仓库锁（`.git/sync-upstream.lock`），预览与 `--undo` 同样如此，运行结束即释放。

```bash
sync-upstream                      # 抢不到锁立刻失败
sync-upstream --lock-wait 30000    # 最多等 30 秒，等不到再失败
```

- 默认 `lockWaitMs: 0`，即不等待：只要有别的运行持锁就失败，退出码 **5**，报错里写明持锁者的 pid、任务标签、开始时间与锁文件路径
- `--lock-wait <毫秒>` 期间每 200ms 重试一次，`-V` 会打印已等待时长
- 持锁进程已退出，或锁龄超过 30 分钟，会被判定为过期锁并自动接管，同时打印 `发现过期锁（pid … 已退出或超过 1800s），接管: …`
- 运行中如果发现锁已不在自己手里（被超时接管），会立刻中止，避免和新的持锁者交错提交
- 崩溃留下的锁若不符合过期条件，确认没有其它进程在跑之后直接删掉 `.git/sync-upstream.lock` 即可
- 守护进程队列里的多次投递在本进程内也是串行的，不会互相抢锁

## 全量与增量

| 方式 | 配置等价 | 行为 |
|---|---|---|
| `--force`（默认 `forceOverwrite: true`） | 忽略状态文件 | 应用计划里的全部变更 |
| `--incremental` | `forceOverwrite: false` | 对照 `.sync-state.json` 的同步记录，跳过上游内容没有新变化的文件，只处理新变化的部分 |

状态文件按"上游仓库 + 上游分支 + 公司分支"绑定，换掉其中任何一项都会自动重建。它删掉也不会让仓库出问题，代价是增量基线、`history` 的记录和 `--undo` 的参照一起消失，下一次只能全量比对；所以把它当本地缓存看待，别提交。记录里除了上游内容哈希还有文件权限，所以只改权限（例如新增可执行位）也会被视为新变化。本次同步里被删除的路径也会从记录中清除，不会被下次误判为"已同步"。多上游时每个来源各有一份状态文件，互不打扰。各运行产物的用途与能否删除见 [运行产物与清理](/reference/configuration#运行产物与清理)。

## 提交内容的边界

提交只携带本次应用的路径。因此：

- 你工作区里其他人的未提交改动、未跟踪产物不会被卷进来
- 上游把文件原样搬家时，被识别为重命名的改动用 `git mv` 一次完成；没识别出来的按"旧路径删除 + 新路径写入"进入同一个提交，不会残留旧路径
- 子模块指针等非文件条目不参与同步
- 同步目录外的任何内容都不被读取、修改或提交

## 重命名识别

上游给文件改名（内容基本没变）时，默认识别成一次重命名，而不是"删旧文件 + 加新文件"：计划里打印成 `>` 一行，应用时用 `git mv` 完成，文件历史和本地改动都保得住。

```bash
sync-upstream --no-renames           # 关掉识别，回到删除 + 新增
sync-upstream --renames              # 显式打开（配置里关了时用）
sync-upstream --rename-threshold 80  # 相似度门槛，默认 60（百分比）
```

对应配置键是 `renameDetection`（默认 `true`）与 `renameThreshold`（默认 `60`，允许 1-100）。相似度低于门槛的那一对改动仍按删除 + 新增处理。三种情况会自动关掉重命名识别并给出警告，本次运行照常同步：

- `deletePolicy: keep`——改名同样会移除旧路径，与"不删本地文件"的承诺冲突
- 灰度发布——改名只能整体应用，没法按百分比分批
- `fetchConfig.depth`——抓取深度之外的旧路径取不到内容，相似度无从计算

重命名也可能带来冲突：旧路径本地有未提交改动、上游又同时改了内容 → `delete-modify`；新路径本地已有同名未跟踪文件 → `untracked-overwrite`。详见 [冲突处理](/guide/conflicts)。

## 上游删除怎么办

上游删掉一个文件时，本地要不要跟着删，由 `deletePolicy` 决定（默认 `mirror`）：

| 策略 | 行为 | 命令行 |
|---|---|---|
| `mirror` | 跟随上游删除，旧路径进入提交 | `--delete-policy mirror`，或 `--delete` |
| `keep` | 本地文件原样保留，计划里记为 `delete-protected` 跳过 | `--delete-policy keep`，或 `--no-delete` |
| `ask` | 每次运行先问一句，答"否"就保留 | `--delete-policy ask`（没有单独的 `--ask` 开关） |

`ask` 每次运行问一句"上游删除了 N 个文件，本次是否同步删除?"，默认答案是"否"，`Ctrl+C` 也算"否"。问不出话的场合一律按保留处理并给出警告：`-y`、`--json`、预览模式都是如此——漏删一次下次还能补，误删一个没人审批的文件追不回来。`--delete` / `--no-delete` 会盖过配置文件里的 `deletePolicy`，适合临时改主意。

## 多个上游与任意 ref

一次运行可以从多个上游取改动（fan-in）：写 `upstreams` 数组，或在命令行上重复 `-r` / `-b`。

```bash
sync-upstream \
  -r https://github.com/vuejs/core.git -b main \
  -r https://github.com/vuejs/router.git -b master
```

- 数组项可写 `repo`、`branch`、`dirs`、`message`；省略的项沿用顶层配置
- 重复的 `-r` / `-b` 按位置配对，较短的一侧会重复使用它的第一个值，所以 `-r a -r b -b main` 合法
- 来源按配置顺序逐个执行，每个来源打印一行 `── 源 1/2: 仓库名@分支` 分隔；某个来源失败会中断本次运行，后面的来源不再执行
- 每个来源抓取到独立的 remote（第一个仍是 `sync-upstream`，其余为 `sync-upstream-2`、`sync-upstream-3`……），各建一份增量状态文件，各产生一个提交
- `upstreams` 多于一个来源时，灰度发布、`--rollback`、`--full-release` 会被直接拒绝（退出码 2），见 [灰度发布](/guide/gray-release)

`upstreamBranch`（含每一项的 `branch`）接受上游的任何 ref：分支、标签、提交号，或 `refs/…` 完整写法。日志与输出会写明它被当作分支、标签还是提交；纯十六进制的值需要含字母才被读作提交号，想指定纯数字的提交请写 `refs/…`。

## 大仓库抓取与 Git LFS

同步 monorepo 里的几个目录，过去意味着把源分支的全部对象都拉下来。`fetchConfig` 可以只拉需要的部分：

```bash
sync-upstream --fetch-filter blob   # blobless：提交与目录树先到，文件内容按需取
sync-upstream --fetch-filter tree   # treeless：只先拉提交，最省流量
sync-upstream --fetch-depth 50      # 浅抓取，只要最近 50 个提交
sync-upstream --fetch-tags          # 顺带把标签拉下来（默认 --no-fetch-tags）
```

- `filter` 默认 `none`，即完整抓取，也是唯一能离线查看上游文件内容的模式；`tree` 会显著增加按需回源的请求次数，宽目录同步可能比完整抓取更慢
- `depth` 会把本地仓库变成浅仓库（`.git/shallow`），别人的 `git log` 也会跟着变短，且会关掉重命名识别，只在确实需要时写
- `lfs` 决定上游用 Git LFS 存的文件落到本地是什么：`pointer`（默认，只写指针文本，不联网、不会因为 LFS 服务不可达而失败）、`materialize`（写完指针再取真实内容，本机需装 `git-lfs` 且上游 LFS 服务可达）、`off`（完全不检测）
- 取回失败或本机没有 `git-lfs` 只影响这些文件，运行不会因此失败；命中的指针数量与列表会打在日志、`--json` 与 CI 摘要里

参数逐项见 [CLI 参考](/reference/cli)，配置写法见 [配置指南](/guide/configuration)。

## 分支策略

需要每次同步落在独立分支上时启用（只在真实运行生效，预览不切分支）：

```json
{
  "branchStrategyConfig": {
    "enable": true,
    "strategy": "feature",
    "baseBranch": "company/main",
    "branchPattern": "feature/sync-{date}"
  }
}
```

`branchPattern` 支持 `{date}`（`YYYY-MM-DD`）、`{base}`、`{strategy}`，其中的 `\` 会被归一成 `/`。分支已存在则直接切过去，不存在则从 `baseBranch` 创建；基准分支缺失会报错而不是凭空生成。

两个收尾开关：

- `autoSwitchBack`（默认 `true`）：提交完成后切回运行前所在的分支，不会把你留在 `feature/sync-…` 上；写成 `false` 则停在同步分支
- `autoDeleteMergedBranches`（默认 `false`）：清理"同一 `branchPattern` 前缀生成、且已合进目标分支"的旧同步分支。当前分支、目标分支与 `baseBranch` 都不会被删，未合并的分支也用普通删除（`git branch -d`）处理，删不掉就留着

## 改动走 PR

`prConfig`（`--pr`）把同步结果变成一个待评审的分支，而不是直接落在目标分支上：改动提交到自动生成的 `sync-upstream/{target}-{date}`（`{date}` 为 `yyyymmdd`），推送后再尝试用 `gh` / `glab` 开 PR；平台 CLI 不在或不允许创建时，只打印一条可以自己打开的比较链接。

```bash
sync-upstream --pr --pr-draft         # 分支照推，PR 以草稿状态创建
sync-upstream --pr --pr-no-create     # 只推分支，PR 自己开
```

要点：

- 目标分支全程不动，`autoPush` 在 PR 模式下不会推目标分支（会给出提示），推的是 PR 分支
- 分支名撞上已有分支时改用 `-2`、`-3` 后缀，不往可能正在评审的分支上追加提交；本次没有任何变更时不建空分支，直接删掉刚建的
- 推送失败、找不到 `gh` 只写成提示，不会让本次运行失败——本地提交已经在了
- PR 模式读写都不碰增量状态文件：分支上的内容还没进目标分支，记成"已同步"会误导下一次
- `prConfig` 与预览/`dryRun`、`branchStrategyConfig`、`grayReleaseConfig` 互斥，同时出现会被拒绝（退出码 2），见 [参数组的行为边界](/reference/cli#参数组的行为边界)
- `--pr-branch`、`--pr-remote`、`--pr-title`、`--pr-body` 覆盖分支模板、推送远端与 PR 标题正文

## 同步记录

每次真实运行只要产生了提交，就会在状态文件里记一条历史：commit、来源（上游的分支/标签/提交）、时间、文件数、这批文件的路径、运行前的 HEAD 与所在分支。最多保留 50 条。

```bash
sync-upstream history            # 最近 10 条
sync-upstream history --limit 30
sync-upstream history --json
```

输出里 `●` 标出最近一次同步（也就是 `--undo` 会撤销的那条），`当前 HEAD` 说明它还没被后续提交盖过，`commit 已不可用` 说明对象已被回收或分支被改写。多上游时按来源分组列出各自的历史。

## 撤销最近一次同步

```bash
sync-upstream --undo    # 或 -uo
```

撤销用 `git revert` 生成一个反向提交，不改写历史——同步提交可能已经推出去被别人拉走。它的行为边界：

- 只处理记录里的最新一条；那条提交已经不是 HEAD 时什么都不做，并提示你自己执行 `git revert <commit>`
- 记录里的分支还在但当前不在其上时会先切过去；分支已经不存在则报"无法确定撤销范围"
- 撤销成功后，这批路径在增量状态里被标记为未同步，对应历史记录被移除，下一次同步会重新应用上游内容
- `--undo` 不抓取上游，只回退本地记录的那一次；它同样受仓库锁约束，配置了 `autoPush` 时会把撤销提交推到目标分支
- 状态文件里没有历史记录（首次同步之前或旧版本写的文件）时打印"未撤销"，退出码 1

成功输出形如：

```text
已撤销同步 1a2b3c4d（163 个文件）
  撤销提交: 9f8e7d6c · 分支 company/main
  增量状态里这些路径已标记为未同步，下次同步会重新应用上游内容。
```

灰度发布的分批与回滚是另一套机制，见 [灰度发布与回滚](/guide/gray-release#回滚做了什么)。

## 本地改动会怎样

同步范围内本地已修改但未提交的文件（`git status` 里的已跟踪改动）会同时参与冲突判定：

- 上游要改的文件你本地也改了 → `content` 冲突
- 上游要删的文件你本地改了 → `delete-modify` 冲突
- 上游新增的路径在你这儿是未跟踪文件 → `untracked-overwrite` 冲突

详见 [冲突处理](/guide/conflicts)。
