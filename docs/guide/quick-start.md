# 快速开始

目标：五条命令走完"装好 → 配置 → 预览 → 同步 → 推送"。全程只碰你指定的目录。

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

## 2. 生成配置文件

```bash
cd /path/to/your-repo
sync-upstream --generate-config
```

写出 `./sync-upstream.config.json`（内容就是全部默认值，带注释意义的键都在）。想换格式或路径：

```bash
sync-upstream -g -F yaml                       # → ./sync-upstream.config.yaml
sync-upstream -g -C config/sync.json5          # → 写到指定路径，格式按扩展名推断
```

`--help` / `--version` / `--generate-config` 三条在任何其他校验之前执行，所以配置还没写也能先跑它们。

## 3. 填三个必填项

`upstreamRepo`、`syncDirs`、`companyBranch` 决定"从哪同步、同步什么、同步到哪"：

```json
{
  "upstreamRepo": "https://github.com/vuejs/core.git",
  "upstreamBranch": "main",
  "companyBranch": "company/main",
  "syncDirs": ["packages/shared"],
  "commitMessage": "chore(sync): sync packages/shared from upstream"
}
```

`syncDirs` 既可以写目录，也可以写**单个文件的路径**（如 `["package.json"]`），后者只匹配那一个文件。

其余字段全部可选，缺省走内置默认值；分层覆盖规则见 [配置文件](/guide/configuration)。

## 4. 先看计划

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

## 5. 真正执行

```bash
sync-upstream               # 应用计划并提交
sync-upstream -p            # 提交后推送到目标分支的上游
```

```text
应用完成: 3 个文件写入, 0 个保留本地, 0 个失败
已提交 1a2b3c4d（3 个文件）
```

提交只携带本次应用的路径，你工作区里别人的未提交改动不会被卷进来。想只同步"上次以来变化的部分"，加 `--incremental`。

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
- **工具不读任何环境变量**：`--auth-token "$GIT_TOKEN"` 能生效是因为 shell 先展开了它。CI 里请用自己的方式注入，配置文件同理。
- 你的 git 代理、`insteadOf`、凭据助手配置照常生效，工具调用的是本机 `git`。

## 下一步

- 按任务看：[日常同步](/guide/sync-basics) · [冲突处理](/guide/conflicts) · [灰度发布与回滚](/guide/gray-release) · [Webhook 守护](/guide/webhook) · [CI 与自动化](/guide/automation)
- 逐项查参数：[命令行参考](/reference/cli) · [配置参考](/reference/configuration) · [API 参考](/reference/api)
