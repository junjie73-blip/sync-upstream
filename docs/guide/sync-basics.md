# 日常同步

覆盖一次同步里最常碰到的四件事：预览、交互、应用与提交边界、分支策略。冲突、灰度、webhook、CI 各自单独成页，见 [使用总览](/guide/usage)。

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
- packages/shared/src/old.ts (packages/shared)
冲突: 2 个文件本地与上游都有改动
  ! packages/shared/src/const.ts [content]
跳过 7 个文件 — 被忽略规则排除
本地已修改文件 3 个（仅同步目录内）
```

`+` 新增、`~` 修改、`-` 删除；括号里是命中的同步范围（`syncDirs` 项，可以是目录或单个文件）。跳过原因有四类：

| 原因 | 打印文案 | 触发条件 |
|---|---|---|
| `ignored` | 被忽略规则排除 | 命中内置忽略、`.gitignore`、`.syncignore`、`ignorePatterns` 或目录级 `.gitignore` |
| `file-type` | 文件类型不在白名单 | 设了 `includeFileTypes` 且扩展名不在列表内 |
| `already-synced` | 已是最新 | 增量模式（`forceOverwrite: false` / `--incremental`）下，该文件的上游内容与 `.sync-state.json` 里的记录一致，没有新变化 |
| `outside-sync-dirs` | 不在同步目录内 | 范围外的文件不会进入计划，此项一般不会出现在输出中，仅用于诊断 |

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

## 全量与增量

| 方式 | 配置等价 | 行为 |
|---|---|---|
| `--force`（默认 `forceOverwrite: true`） | 忽略状态文件 | 应用计划里的全部变更 |
| `--incremental` | `forceOverwrite: false` | 对照 `.sync-state.json` 的同步记录，跳过上游内容没有新变化的文件，只处理新变化的部分 |

状态文件按"上游仓库 + 上游分支"绑定，换了上游会自动重建；它属于可安全删除的缓存，删掉后下一次全量比对即可。本次同步里被删除的路径也会从记录中清除，不会被下次误判为"已同步"。各运行产物的用途与能否删除见 [运行产物与清理](/reference/configuration#运行产物与清理)。

## 提交内容的边界

提交只携带本次应用的路径。因此：

- 你工作区里其他人的未提交改动、未跟踪产物不会被卷进来
- 上游把文件原样搬家（重命名）时，旧路径的删除和新路径的写入会进入同一个提交，不会残留旧路径
- 子模块指针等非文件条目不参与同步
- 同步目录外的任何内容都不被读取、修改或提交

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

`autoSwitchBack` 与 `autoDeleteMergedBranches` 两个键目前不生效：写了也不会有"同步完自动切回"或"清理已合并分支"的行为。

## 本地改动会怎样

同步范围内本地已修改但未提交的文件（`git status` 里的已跟踪改动）会同时参与冲突判定：

- 上游要改的文件你本地也改了 → `content` 冲突
- 上游要删的文件你本地改了 → `delete-modify` 冲突
- 上游新增的路径在你这儿是未跟踪文件 → `untracked-overwrite` 冲突

详见 [冲突处理](/guide/conflicts)。
