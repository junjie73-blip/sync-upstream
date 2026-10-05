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

## 验证

```bash
sync-upstream --version   # 输出版本号
sync-upstream --help      # 输出完整参数列表
```

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
