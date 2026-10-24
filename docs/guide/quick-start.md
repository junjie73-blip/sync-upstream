# 快速开始

目标：装好之后先问一句"现在什么状态"，再预览、再同步。全程只碰你指定的目录。

## 前置条件

| 项目 | 要求 |
|---|---|
| Node.js | ≥ 18.2 |
| Git | ≥ 2.25 |
| 当前目录 | 已 `git init` 的仓库（工具不会替你初始化仓库） |
| 目标分支 | 已存在（本地或 `origin`），预览模式不会创建分支 |

版本自检：

```bash
node -v
git --version
sync-upstream --version
```

## 1. 安装

```bash
npm install -g sync-upstream        # 全局安装，得到 sync-upstream 命令
# 或不安装，直接在仓库里用：
npx sync-upstream --help
```

细节见 [安装指南](/guide/installation)。

## 2. 问答式生成配置

第一次用不着对着字段表挨个填，`init` 会问你需要决定的那几项：

```bash
cd /path/to/your-repo
sync-upstream init
```

问题依次是：文件格式、上游仓库、同步目录（逗号分隔）、上游分支（分支/标签/提交号都行）、目标分支、提交消息、上游删掉的本地文件怎么处理（`mirror`/`keep`/`ask`）、冲突怎么处理、同步后要自动推送吗。写完打印一句 `配置已写入 <绝对路径>`，直接回车即采用括号里的默认值。

- 只写你回答过的那几个字段，其余全部走内置默认值，文件小得能一眼读完
- 落盘前先按真实运行的规则校验一遍，所以它不会产出一个"下一跑就拒绝加载"的文件
- 目标文件已存在时需要 `-f` 才覆盖：`sync-upstream init -f`
- `-C` 指定写到哪个文件，`-F` 指定格式（`json`/`json5`/`yaml`/`toml`），默认 `sync-upstream.config.json`
- 它需要交互终端：带 `--json`、带 `-y`，或者根本没有 tty（CI、管道里就是这样）时会被拒绝，退出码 2

## 3. 或者直接要一份全字段模板

```bash
sync-upstream --generate-config
```

写出 `./sync-upstream.config.json`（每个字段都带注释，适合对着文档改）。想换格式或路径：

```bash
sync-upstream -g -F yaml                       # → ./sync-upstream.config.yaml
sync-upstream -g -C config/sync.json5          # → 写到指定路径，格式按扩展名推断
```

`--help` / `--version` / `--generate-config` 三条在任何其他校验之前执行，所以配置还没写也能先跑它们。

## 4. 必填的那三项

`upstreamRepo`、`syncDirs`、`companyBranch` 决定"从哪同步、同步什么、同步到哪"（用 `init` 生成的文件已经写好了）：

```json
{
  "upstreamRepo": "https://github.com/vuejs/core.git",
  "upstreamBranch": "main",
  "companyBranch": "company/main",
  "syncDirs": ["packages/shared"],
  "commitMessage": "chore(sync): sync packages/shared from upstream"
}
```

`syncDirs` 既可以写目录，也可以写**单个文件的路径**（如 `["package.json"]`），后者只匹配那一个文件。`upstreamBranch` 不限于分支：标签、提交号、`refs/…` 都能写。

其余字段全部可选，缺省走内置默认值；分层覆盖规则见 [配置文件](/guide/configuration)。

## 5. 先看清楚现状

三个只读子命令不会改工作区、不会切分支、不会提交，`--json` 每个都支持：

```bash
sync-upstream status              # 分支、目标分支、待同步计数、配置、仓库锁与上游快照（不联网）
sync-upstream doctor              # 体检：Node/git、配置、认证、分支、同步目录、状态文件、仓库锁、工作区改动，以及 webhook/通知/灰度/删除改名/抓取/日志/PR
sync-upstream why packages/shared/src/index.ts   # 这个文件为什么会被同步 / 跳过
```

`doctor` 有阻塞项时退出码是 1，可以直接当 CI 的前置检查用；`status` 不带 `--fetch` 时不联网，读的是本地已有的上游快照。仓库里还没有配置文件时这三条也照样能跑（`why` 除外，它需要一份可用配置才能回答），缺少的字段会逐条出现在输出与 `--json` 的 `warnings` 里。

## 6. 先看计划

```bash
sync-upstream -P            # 预览
sync-upstream -P -V         # 预览并列出全部变更路径（默认只显示前 40 条）
```

输出示例：

```text
计划: 3 项变更 (源 refs/remotes/sync-upstream/main → 目标 company/main)
+ packages/shared/src/new-file.ts (packages/shared)
~ packages/shared/src/index.ts (packages/shared)
- packages/shared/src/old.ts (packages/shared)

 WARN  预览模式：不会修改工作区
```

预览**不会**切换分支、修改工作区、暂存或提交；它仍会添加或更新名为 `sync-upstream` 的 remote 并拉取上游内容，这些写入只影响仓库的 git 数据，不碰你的文件。

## 7. 真正执行

```bash
sync-upstream               # 应用计划并提交
sync-upstream -p            # 提交后推送到目标分支的上游
```

```text
应用完成: 3 个文件写入, 0 个保留本地, 0 个失败
已提交 1a2b3c4d（3 个文件）
```

提交只携带本次应用的路径，你工作区里别人的未提交改动不会被卷进来。想只同步"上次以来变化的部分"，加 `--incremental`。跑完反悔了有 `sync-upstream --undo`，跑过几次想回看有 `sync-upstream history`，见 [日常同步](/guide/sync-basics#撤销最近一次同步)。

## 三种常见起步姿势

**零配置一把梭**（字段传齐并加 `-y` 才不会提问）：

```bash
sync-upstream -y -r https://github.com/org/upstream.git -d src/utils,docs -b main -c company/main -P
```

**CI 里跑**（配置完整 + `-y` 才是零提问；`-y` 之下 `prompt-user` 冲突策略自动降级为保留本地）：

```bash
sync-upstream -C sync-upstream.config.json -y --conflict-strategy keep-target --push
```

**灰度先行**（先发 20%，验证过再全量）：

```bash
sync-upstream -gr --percentage 20
sync-upstream -gr --full-release
```

## 私有仓库认证

三种方式，必须显式指定 `--auth-type`（不给时其余认证字段一律不生效）：

```bash
# SSH：指定私钥
sync-upstream -r git@github.com:org/private.git -d src/utils --auth-type ssh --auth-key ~/.ssh/id_ed25519

# 令牌
sync-upstream -r https://github.com/org/private.git -d src/utils --auth-type pat --auth-token <token>

# 用户名 + 密码
sync-upstream -r https://gitlab.example.com/org/private.git -d src/utils \
  --auth-type user_pass --auth-username <用户名> --auth-password <密码>
```

也可以写进配置文件的 `authConfig`，字段同名。

需要注意的几点：

- **凭据会留在你仓库里**：`pat` / `user_pass` 的凭据被写进 `.git/config` 的 `sync-upstream` remote URL。日志与报错里的地址一律脱敏，但别把 `.git/config` 贴进 issue 或日志归档。用 SSH 时 URL 里没有密钥。
- **私钥带口令要先交给 ssh-agent**：工具不会交互式询问口令，遇到带口令的私钥会直接失败。
- **工具不会自己去读凭据环境变量**：`--auth-token "$GIT_TOKEN"` 能生效是因为 shell 先展开了它。工具只读这几个变量：`SYNC_UPSTREAM_LANG`、`LC_ALL`、`LANG`、`LANGUAGE`（输出语言）与 `GITHUB_STEP_SUMMARY`（CI 摘要）。CI 里请用自己的方式注入，配置文件同理。
- 你的 git 代理、`insteadOf`、凭据助手配置照常生效，工具调用的是本机 `git`。

## 下一步

- 按任务看：[日常同步](/guide/sync-basics) · [冲突处理](/guide/conflicts) · [灰度发布与回滚](/guide/gray-release) · [Webhook 守护](/guide/webhook) · [CI 与自动化](/guide/automation)
- 逐项查参数：[命令行参考](/reference/cli) · [配置参考](/reference/configuration) · [API 参考](/reference/api)
