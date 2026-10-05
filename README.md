# sync-upstream

🚀 **目录级上游代码同步工具**

把上游仓库中你关心的那几个目录，以**可预览、可审计、可回滚**的方式同步到你的分支，并且只碰这些目录。

简体中文 | [English](README.en.md) · 文档站：[使用指南](https://flow-zy.github.io/sync-upstream/)（中文 / English）

---

## 为什么需要它

维护开源分叉时，`git merge upstream/main` 会把上游的**全部**改动灌进来，而现实里你往往只想跟 `src/config`、`packages/utils` 这几个目录：

- 手工复制文件容易漏、容易覆盖本地定制代码，且没有审计痕迹
- 用临时分支 + 临时目录做同步，一旦中断就会留下脏状态
- 预览说改了 100 个文件，实际提交只有 98 个，差在哪没人说得清
- 冲突只能靠肉眼看，没有"保留本地 / 采用上游 / 三方合并"的策略选择

sync-upstream 的三条承诺：**只碰你列出的目录**、**预览看到的每一条就是提交里的每一条**、**不建临时分支也不建临时目录，中断了重跑就行**。

如果你正在考虑"GitHub / Gitee 的 Fetch upstream 一个按钮就行了，为什么要装工具"，看 [与 fork 同步的对比](docs/guide/vs-fork-sync.md)——里面有逐条例子，也写明了哪些场景确实不该用它。

> 运行前提：当前目录已经是一个 Git 仓库（`git init` 即可），且目标分支已存在。

---

## 核心特性

### 同步
- **目录级作用域**：只同步 `syncDirs` 列出的路径（目录或单个文件均可），范围外的文件不会被读取、修改或提交
- **预览等于结果**：`-P` / `-n` 只列出这次要新增/修改/删除的路径，不动工作区、不切分支、不提交（仍会拉取上游，离线会失败）
- **增量运行**：`--incremental` 跳过上次已同步的内容，只处理之后变化的文件；`--force` 忽略基线重新全量比对
- **失败不扩散**：文件多时批量应用，个别文件失败只标记该文件并保留原因，其余照常完成，修好重跑即可
- **专属 remote**：上游以名为 `sync-upstream` 的 remote 拉取，绝不改写你的 `origin`

### 冲突处理
- 自动识别 4 类冲突：内容都改（`content`）、一边删一边改（`delete-modify`）、本地未跟踪文件将被覆盖（`untracked-overwrite`）、文件与目录同名（`type`）
- 5 种解决策略：`use-source`、`keep-target`、`auto-merge`、`prompt-user`、`skip`
- `auto-merge` 会尝试自动合并双方的行级改动，合不上时写入冲突标记交给你处理，而不是静默丢弃
- 二进制文件与超大文本不尝试自动合并，只跳过该文件，不影响同批其他文件

### 发布控制
- **灰度发布**：按百分比 / 目录 / 文件模式先发布一小批，重跑同一比例得到的是同一批文件
- **一键全量 / 回滚**：`--full-release` 补齐剩下的文件；`--rollback` 把已发布的内容退回发布前——新提交一条回滚提交，不改写已推送的历史
- **审计**：阶段变迁追加写入 `.sync-gray-audit.jsonl`，可随时改路径

### 配置与报错
- **多格式配置**：JSON / JSON5 / YAML / TOML，自动探测 16 个候选文件名，`-C` 可显式指定
- **失败即报错**：指定的配置文件不存在、无权限、解析失败都会终止并报出每种格式的失败原因，绝不静默回落到默认值
- **聚合校验**：一次性列出所有配置问题（类型错误、路径非法、枚举拼错、区间越界），并对别名键、未识别键给出警告
- **明确退出码**：0 成功 / 1 有文件应用失败或未预期错误 / 2 配置或参数问题 / 3 git 操作失败（4 为保留码）
- **Webhook 守护模式**：支持 GitHub / GitLab / Bitbucket / Gitea，签名或 token 校验、IP 白名单、按 IP 限流、1 MiB 请求体上限

---

## 30 秒上手

```bash
npm install -g sync-upstream

cd /path/to/your-repo
sync-upstream --generate-config          # 生成 sync-upstream.config.json
# 编辑里面的 upstreamRepo / syncDirs / companyBranch
sync-upstream --preview-only --verbose   # 先看计划
sync-upstream                            # 再真正执行
```

也可以零配置直接跑，工具会交互式询问缺少的字段：

```bash
sync-upstream -r https://github.com/vuejs/core.git -d packages/runtime-core -b main -c company/main
```

脚本与 CI 里用 `-y` 跳过提问（配置需完整：`upstreamRepo` 与 `syncDirs` 都要有值，否则仍会进入补全问答）：

```bash
sync-upstream -C sync-upstream.config.json -y --push
```

---

## 配置示例

`sync-upstream.config.json`（下面是规范键名；历史别名仍会被识别，但会提示一次）：

```json
{
  "upstreamRepo": "https://github.com/vuejs/core.git",
  "upstreamBranch": "main",
  "companyBranch": "company/main",
  "syncDirs": ["packages/runtime-core", "packages/shared"],
  "commitMessage": "chore(sync): sync runtime-core from upstream",
  "ignorePatterns": ["**/__tests__/**", "*.log"],
  "includeFileTypes": [".ts", ".vue"],
  "concurrencyLimit": 10,
  "forceOverwrite": true,
  "autoPush": false,
  "verbose": false,
  "retryConfig": {
    "maxRetries": 3,
    "initialDelay": 2000,
    "backoffFactor": 1.5
  },
  "conflictResolutionConfig": {
    "defaultStrategy": "prompt-user",
    "autoResolveTypes": [".md"],
    "logResolutions": true
  },
  "authConfig": {
    "type": "pat",
    "username": "git",
    "token": "read-from-env-or-credential-helper"
  }
}
```

YAML / TOML / JSON5 写法的键名完全一致；`.yaml` 版本可参考 [配置指南](docs/guide/configuration.md)。

---

## CLI 速查表

完整语义（默认值来源、参数组边界、与配置键的对应关系）见 [命令行参考](docs/reference/cli.md)，本表只做快速查询。

| 参数 | 别名 | 类型 | 说明 |
|---|---|---|---|
| `--repo` | `-r` | `<url>` | 上游仓库 URL |
| `--branch` | `-b` | `<分支>` | 上游分支（默认 `main`） |
| `--company-branch` | `-c` | `<分支>` | 目标分支（默认 `main`） |
| `--dirs` | `-d` | `<a,b>` | 同步路径（目录或单个文件），逗号分隔 |
| `--message` | `-m` | `<文本>` | 提交消息 |
| `--push` | `-p` | flag | 提交后自动推送 |
| `--force` | `-f` | flag | 强制应用全部计划变更（覆盖增量判定） |
| `--incremental` | | flag | 只应用上次同步后变更的文件（`forceOverwrite: false`） |
| `--preview-only` | `-P` | flag | 只打印计划，不修改任何内容 |
| `--dry-run` | `-n` | flag | 同 `--preview-only`，用于脚本 |
| `--config` | `-C` | `<路径>` | 指定配置文件；读取失败直接报错 |
| `--config-format` | `-F` | `<格式>` | `json`（默认）/ `json5` / `yaml` / `toml`，用于 `-g` 生成 |
| `--generate-config` | `-g` | flag | 生成默认配置文件后退出 |
| `--non-interactive` | `-y` | flag | 不提问（配置不完整时仍会补全）；`prompt-user` 冲突降级为保留本地 |
| `--ignore` | | `<a,b>` | 追加忽略规则（gitignore 语法） |
| `--include-types` | | `<a,b>` | 仅同步这些扩展名，如 `.ts,.vue` |
| `--conflict-strategy` | | `<s>` | `use-source` / `keep-target` / `auto-merge` / `prompt-user` / `skip` |
| `--retry-max` | | `<n>` | 网络类失败最大重试次数 |
| `--retry-delay` | | `<ms>` | 初始重试延迟 |
| `--retry-backoff` | | `<factor>` | 退避因子 |
| `--concurrency` | | `<n>` | 批量应用失败后逐路径重试的并发数 |
| `--gray-release` | `-gr` | flag | 启用灰度发布 |
| `--strategy` | | `<s>` | 灰度策略：`percentage`（默认）/ `directory` / `file` |
| `--percentage` | | `<n>` | 灰度百分比，区间 `(0, 100]`，CLI 默认 20 |
| `--canary-dirs` | | `<a,b>` | `directory` 策略的金丝雀目录 |
| `--file-patterns` | | `<a,b>` | `file` 策略的文件模式 |
| `--validation-script` | | `<命令>` | 灰度校验命令，非 0 退出即校验失败 |
| `--full-release` | `-fr` | flag | 发布灰度阶段剩下的文件 |
| `--rollback` | `-ro` | flag | 回滚 `.sync-gray.json` 记录的那次发布 |
| `--auth-type` | | `<t>` | `ssh` / `pat` / `user_pass` |
| `--auth-username` / `--auth-token` / `--auth-password` / `--auth-key` | | `<值>` | 对应认证凭据 |
| `--webhook-enable` | `-we` | flag | 以 webhook 守护模式常驻运行 |
| `--webhook-port` | | `<n>` | 监听端口（默认 3000） |
| `--webhook-path` | | `<路径>` | 回调路径（默认 `/webhook`） |
| `--webhook-secret` | | `<密钥>` | 签名校验密钥，空密钥一律拒绝请求 |
| `--webhook-events` | | `<a,b>` | 允许的事件（默认 `push`） |
| `--webhook-branch` | | `<分支>` | 触发同步的分支（默认 `main`） |
| `--verbose` | `-V` | flag | verbose 级日志 + 完整变更清单（不含 debug） |
| `--silent` | `-s` | flag | 只输出错误 |
| `--version` | `-v` | flag | 显示版本 |
| `--help` | `-h` | flag | 显示帮助 |

未识别的参数会被直接拒绝（退出码 2）并提示使用 `--help`，不会被静默忽略。

---

## 运行期间会碰什么

| 对象 | 位置 | 说明 |
|---|---|---|
| `.sync-state.json` | 仓库根 | 增量同步的基线；换上游仓库/分支自动作废重建，删掉也安全 |
| `.sync-gray.json` | 仓库根 | 灰度发布进度；**灰度进行中不要删**，全量发布成功后自动删除 |
| `.sync-gray-audit.jsonl` | 仓库根 | 灰度阶段审计，纯记录，可用 `grayReleaseConfig.auditLogPath` 改路径 |
| remote `sync-upstream` | `.git/config` | 工具专属的上游 remote，不影响 `origin`，可随时 `git remote remove` |
| 提交 | 目标分支 | 只包含本次应用的那些路径，不会把无关的脏文件卷进来 |

内置忽略规则保证 `.sync-state.json`（连同旧版遗留的 `.sync-cache/`、`.sync-temp/`、`.sync-hashes.json`）不会进入同步范围；**两个灰度文件不在其中**，把仓库根当同步目录时请手工排除。使用 `pat` / `user_pass` 认证时，remote URL 会带上凭据——别把 `.git/config` 贴进日志或 issue（日志与报错里的 URL 已自动脱敏）。逐项细节见[运行产物与清理](docs/reference/configuration.md#运行产物与清理)。

---

## 常见问题速查

| 现象 | 原因与处理 |
|---|---|
| `Not a git repository` | 当前目录不是 git 仓库：`git init` 后重试 |
| `配置文件不存在: ...` | `-C` 指定的路径找不到；工具不会回落到默认值，请修正路径 |
| `配置文件 x.json 解析失败` | 错误里列出了每种格式的失败原因，按提示改语法 |
| `配置校验失败: - ...` | 一次列全部问题；按项修正 `upstreamRepo` / `syncDirs` / 枚举值等 |
| `目标分支 x 既不在本地也不在 origin` | 预览模式不会替你建分支，先 `git branch -r` 确认分支名 |
| `推送到 origin/xxx 失败` | 检查凭据与分支保护；提交已在本地，可单独 `git push` |
| 计划为空但预期有变更 | 上一轮已同步过；用 `--force` 忽略 `.sync-state.json` 重新全量比对 |

日志与退出码细节见 [FAQ](docs/faq.md)，完整字段说明见 [配置参考](docs/reference/configuration.md)。

---

## 文档地图

文档站是**纯使用指南**：安装、操作、配置、排错；内部实现与架构不在这套文档里。本地用 `pnpm docs:dev` 预览：

| 分区 | 页面 | 讲什么 |
|---|---|---|
| 选型 | [与 fork 同步的对比](docs/guide/vs-fork-sync.md) | 什么时候用自带 "Fetch upstream" 就够，什么时候需要本工具 |
| 上手 | [快速开始](docs/guide/quick-start.md) · [安装指南](docs/guide/installation.md) · [配置文件](docs/guide/configuration.md) | 前置条件、安装、生成并填好第一份配置 |
| 使用 | [使用总览](docs/guide/usage.md) | 一次运行会做什么、各页入口 |
| 使用 | [日常同步](docs/guide/sync-basics.md) | 预览、交互、应用与提交边界、分支策略 |
| 使用 | [冲突处理](docs/guide/conflicts.md) | 4 类冲突、5 种策略、自动合并的边界 |
| 使用 | [灰度发布与回滚](docs/guide/gray-release.md) | 选择策略、阶段与状态、校验、回滚 |
| 使用 | [Webhook 守护模式](docs/guide/webhook.md) | 请求处理顺序与状态码、签名、事件过滤 |
| 使用 | [CI 与自动化](docs/guide/automation.md) | 非交互、退出码、日志、并发与重试、失败重来 |
| 参考 | [命令行参考](docs/reference/cli.md) · [配置参考](docs/reference/configuration.md) · [API 参考](docs/reference/api.md) | 参数、字段、编程入口逐项说明 |
| 项目 | [功能记录](docs/features.md) · [常见问题](docs/faq.md) · [更新日志](docs/changelog.md) | 功能与限制、排错、变更历史 |
| English | [docs/en/](docs/en/) | 与中文逐页对应的完整英文版 |

- 英文说明：[README.en.md](README.en.md)
- 变更历史：[CHANGELOG.md](CHANGELOG.md)
- 要求：Node.js ≥ 18.2、Git ≥ 2.25
- 开发：`pnpm install` → `pnpm test` → `pnpm build`；欢迎提 issue 与 PR，请先跑通 `pnpm lint && pnpm test`，并在 PR 里说明对应的行为变化

---

License: MIT
