# 安装指南

## 环境要求

| 依赖 | 最低版本 | 原因 |
|---|---|---|
| Node.js | 18.2 | 运行环境要求；低于该版本 Webhook 守护模式无法正常关闭连接 |
| Git | 2.25 | 低于该版本无法保证"只提交本次同步的路径" |
| pnpm / npm | 任意现代版本 | 安装与脚本运行 |

工具直接调用本机的 `git` 子命令，不使用 libgit2，因此你日常的 git 配置（代理、`insteadOf`、凭据助手）都会照常生效。

## 安装

```bash
# 全局安装，得到 `sync-upstream` 命令
npm install -g sync-upstream
# 或
pnpm add -g sync-upstream

# 项目内安装，通过 package.json 锁定版本
pnpm add -D sync-upstream
npx sync-upstream --version
```

npm 上的包名是 `sync-upstream`，当前 `latest` 是 `0.2.8-0`：直接 `npm install -g sync-upstream` 拿到并**不是**本站描述的 0.3.0 功能。0.3.0 的预发布版本发布在 `next` 标签下，所以请按文档版本显式安装 `npm install -g sync-upstream@next`（或 `pnpm add -g sync-upstream@next`、`pnpm add -D sync-upstream@next`）。装好后先跑 `sync-upstream init` 生成第一份配置文件，再跑 `sync-upstream doctor` 确认仓库、git 与远程配置真的能同步——见[快速开始](/guide/quick-start)。

## 验证

```bash
sync-upstream --version   # 输出版本号
sync-upstream --help      # 输出完整参数列表
```

## Shell 补全

`completion` 把参数表生成的补全脚本打到 stdout，重定向到你的补全目录即可：

```bash
# bash
sync-upstream completion bash > /usr/share/bash-completion/completions/sync-upstream
# zsh（放在 fpath 里的某个目录，文件名必须是 _sync-upstream）
sync-upstream completion zsh > "${fpath[1]}/_sync-upstream"
# fish
sync-upstream completion fish > ~/.config/fish/completions/sync-upstream.fish
```

- 脚本是按当前参数表生成的，升级之后重新执行一次就能补出新参数；`completion` 之后还能继续补出 `bash`/`zsh`/`fish` 三个值
- 只补参数与子命令，不会替你猜仓库地址；shell 名给错时退出码为 2 并打印正确用法
- 写完之后按各 shell 的惯例重开终端（或 `source` 对应文件）加载

## 输出语言

帮助文本、参数报错、错误消息都跟随当前语言，`zh` 与 `en` 二选一：

```bash
sync-upstream --lang en --help     # 本次运行用英文
export SYNC_UPSTREAM_LANG=en       # 只对本工具生效，优先级最高的环境变量
```

判定顺序是 `--lang` → `SYNC_UPSTREAM_LANG` → `LC_ALL` → `LANG` → `LANGUAGE`：以 `zh` 开头的 locale 走中文，其它已识别的 locale 走英文，一个都没有（或只有 `C`/`POSIX`）时保持中文——工具一直这么回答。`--lang` 只切换输出语言，不会写进配置层，也没有对应的配置键；给了 `zh`/`en` 之外的值时，工具会用你原本的语言说明为什么拒绝。

交互问答与配置摘要目前只有中文。

## 在源码仓库里运行

```bash
git clone https://github.com/flow-zy/sync-upstream.git
cd sync-upstream
pnpm install
pnpm build            # 产物在 dist/，bin/sync-upstream 会优先使用它
pnpm test             # 单元测试 + 真实 git 夹具端到端测试
pnpm docs:dev         # 本地预览文档站点
```

`bin/sync-upstream` 在找不到 `dist/cli.js` 时会提示先执行构建，不会静默失败。

## 下一步

- [快速开始](/guide/quick-start)：装好后第一次跑通预览
- [配置指南](/guide/configuration)：写第一份配置文件
- [使用总览](/guide/usage)：所有专项页面的入口
- [命令行参考](/reference/cli)：`--help` 里每条参数的默认值与落点
