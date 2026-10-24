# 使用总览

本页给出一次运行的完整骨架和各个专项文档的入口。具体操作细节按功能拆在独立页面，按需跳转即可。

## 从哪里开始

| 你想做什么 | 去这一页 |
|---|---|
| 先判断该不该用这个工具 | [与 fork 同步的对比](/guide/vs-fork-sync) |
| 第一次装好、跑通预览 | [快速开始](/guide/quick-start) |
| 看懂计划输出、执行真实同步、理解提交边界 | [同步基础](/guide/sync-basics) |
| 处理本地与上游都改过的文件 | [冲突处理](/guide/conflicts) |
| 先发一小部分验证，再全量或回滚 | [灰度发布](/guide/gray-release) |
| 上游有 push 就自动同步 | [Webhook 守护模式](/guide/webhook) |
| 接到流水线 / 定时任务里 | [自动化与退出码](/guide/automation) |
| 同步完反悔了，想撤回这一次 | [同步基础 → 撤销](/guide/sync-basics#撤销最近一次同步) |
| 逐条查命令行参数、子命令与别名 | [CLI 参考](/reference/cli) |
| 改配置字段、查运行留下的文件能不能删 | [配置参考](/reference/configuration) 与 [运行产物与清理](/reference/configuration#运行产物与清理) |

## 一次运行会发生什么

1. 读取配置（默认值 → 配置文件 → 命令行，后者覆盖前者）并做完整性校验，有问题当场报完
2. 确认当前目录是 Git 仓库、目标分支可用，并拿到这个仓库的同步锁（同一仓库同时只允许一次真实同步；被别人占着时按 `--lock-wait` 等待，默认直接失败）
3. 拉取上游分支（网络类失败会按重试策略退避重试）
4. 算出这次要变更的路径清单，套用忽略规则与扩展名白名单
5. 标出本地与上游都有改动的冲突文件
6. 打印清单——预览模式到这里就结束了
7. 真实运行才会：解决冲突 → 写入上游内容 → 提交本次应用的路径 → 记录增量基线 → 按需推送

预览看到的每一行，就是第 7 步提交里出现的每一行；两者是同一份清单。

## 先看再动

```bash
sync-upstream -P            # 预览：不修改工作区、不切分支、不提交
sync-upstream -n            # 同上，脚本习惯用 dry-run
sync-upstream -P -V         # 预览并列出全部变更路径（默认只显示前 40 条）
```

计划输出形如：

```
计划: 163 项变更 (源 refs/remotes/sync-upstream/main → 目标 company/main)
+ packages/shared/src/new-file.ts (packages/shared)
~ packages/runtime-core/src/index.ts (packages/runtime-core)
- packages/shared/src/old.ts (packages/shared)
冲突: 2 个文件本地与上游都有改动
  ! packages/shared/src/const.ts [content]
跳过 7 个文件 — 被忽略规则排除
本地已修改文件 3 个（仅同步目录内）
```

`+` 新增、`~` 修改、`-` 删除。逐行含义与"已是最新 / 不在同步目录内"等跳过条件见 [同步基础](/guide/sync-basics)。

## 不改动任何东西的四个子命令

同步之前想先确认状态，或者事后想知道"这个文件为什么没被动"，用这四个只读子命令。它们不写工作区、不切分支、不提交，也都能在流水线里跑。

```bash
sync-upstream status                 # 分支、目标分支、待同步计数、配置、仓库锁与上游快照（不联网）
sync-upstream status --fetch         # 先拉上游再比对，结果更接近真实运行
sync-upstream why src/a.ts           # 这个文件这次会不会被同步，为什么
sync-upstream doctor                 # 体检：Node/git、配置、认证、分支、同步目录、状态文件、仓库锁、工作区改动，以及 webhook/通知/灰度/删除改名/抓取/日志/PR
sync-upstream history --limit 5      # 最近五次同步改了什么
```

四个都支持 `--json`，输出是一份可直接喂给 `jq` 的文档：带上 `--json` 时 stdout 只有这一个 JSON（彩色行与人读排版都不再打印），日志仍按原样写到 stderr 与日志文件。同一份摘要也会追加进 `$GITHUB_STEP_SUMMARY`（这个环境变量存在时），GitHub Actions 的 Run 页面因此能直接看到数字。

`history` 读的是 `sync-upstream` 自己在每次真实同步后留下的记录，不需要额外开启；`--limit` 默认 10。

`status`、`doctor`、`history` 和 `--undo` 在没有配置文件时也能跑：它们就是给"还没配好 / 配坏了"的场景准备的，缺哪些字段会逐条列在输出与 `--json` 的 `warnings` 里，`doctor` 另把它算作阻塞项（退出码 1）。`why` 是唯一的例外，它答的是"这次同步会不会动这个文件"，没有可用配置就没有计划可依，会以退出码 2 报配置校验失败。

## 四件容易踩的事

- **预览也会写 `.git`**：它会添加/更新 `sync-upstream` remote 并 fetch，只是不动工作区、不切分支、不提交。离线场景下 fetch 失败会直接报错。
- **`syncDirs` 既能写目录也能写单个文件路径**，"只同步一个文件"不需要特殊模式，见 [单文件与局部同步](/guide/automation#单文件与局部同步)。
- **`-y` 不等于绝对不问**：只要配置里缺 `upstreamRepo` 或 `syncDirs` 为空，仍会进入追问补全。CI 里请保证配置完整，见 [自动化与退出码](/guide/automation)。
- **输出语言跟着系统 locale 走**：机器的 `LANG`/`LC_ALL` 不是中文时，帮助与报错会变成英文。想固定下来就设 `SYNC_UPSTREAM_LANG=zh`，或每次带 `--lang zh`。判定顺序与例外见 [CLI 参考 → 语言](/reference/cli#语言-lang)。

## 常用动作速查

```bash
sync-upstream init                       # 问答式生成配置文件（第一次用从这里开始）
sync-upstream -y -C sync-upstream.config.json --push   # 非交互同步并推送
sync-upstream --conflict-strategy auto-merge           # 冲突走三方合并
sync-upstream --no-delete -P                           # 预览，但上游删除的文件先保留
sync-upstream --fetch-filter blob --fetch-depth 50     # 大仓：只取需要的那部分
sync-upstream --pr -P                                  # 预览 PR 模式会推到哪个分支
sync-upstream -gr --percentage 20 -V                   # 灰度先发 20%
sync-upstream -gr --full-release                       # 灰度验证通过后补齐全量
sync-upstream -gr --rollback                           # 回到灰度之前
sync-upstream --undo                                   # 撤销最近一次真实同步
sync-upstream -we --webhook-port 3000                  # Webhook 守护
sync-upstream --lang en --help                         # 换成英文读帮助
sync-upstream completion bash                          # 生成 shell 补全脚本
```

每条命令的行为边界在对应专项页面里说明；参数全集在 [CLI 参考](/reference/cli)。
