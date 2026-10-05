---
# sync-upstream
layout: home

hero:
  name: "sync-upstream"
  text: "目录级上游代码同步"
  tagline: 只同步你指定的目录，先看计划再动手，可灰度、可回滚、可审计
  image:
    src: /sync-upstream-hero.svg
    alt: sync-upstream
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/quick-start
    - theme: alt
      text: 命令行参考
      link: /reference/cli
    - theme: alt
      text: 常见问题
      link: /faq

features:
  - icon: 🎯
    title: 只碰你指定的目录
    details: syncDirs 之外的文件不会被读取、修改或提交，你在其余目录里的定制完全不受影响
  - icon: 🔍
    title: 预览看到的就是提交内容
    details: 先列出这次要新增/修改/删除的每一条路径，确认无误再执行；两者严格一致
  - icon: ⚡
    title: 增量 + 并行
    details: 上次同步过的内容自动跳过，文件多时按并发批量应用，个别文件失败不拖累整批
  - icon: 🧩
    title: 冲突有策略
    details: 本地与上游都改过的文件可自动判别，按采用上游 / 保留本地 / 三方合并 / 跳过处理
  - icon: 🚦
    title: 灰度与回滚
    details: 先发一小部分跑验证，通过再补齐；出问题一条命令退回发布前的内容
  - icon: 🔐
    title: 报错诚实
    details: 配置读不到就终止、参数不认识就拒绝、校验一次报完，日志里的凭据一律脱敏
---

## 这个工具做什么

维护开源分叉时，`git merge upstream/main` 会把上游的**全部**改动灌进来，而现实里你往往只想跟其中几个目录。sync-upstream 把同步范围限制在你列出的目录里，并且每一步都可以预览、审计和回退。

它不试图取代 `git merge`：**如果你需要保留上游的提交历史，用 `git merge`；只要上游的内容、不要它的历史，用这个工具。** 逐场景的对比见[与 fork 同步的对比](/guide/vs-fork-sync)。

## 一次运行会做什么

1. 拉取上游分支，确认目标分支可用
2. 算出这次要变更的路径清单（新增 / 修改 / 删除），叠加忽略规则与扩展名白名单
3. 标出本地与上游都有改动的冲突文件
4. 预览模式到此为止，只打印清单；真实运行才应用变更并提交
5. 需要更稳的发布节奏时，同一份清单可以先发一小部分，再全量或回滚

## 三分钟上手

```bash
npm install -g sync-upstream

cd /path/to/your-repo
sync-upstream --generate-config          # 写出 sync-upstream.config.json
# 编辑 upstreamRepo / upstreamBranch / companyBranch / syncDirs
sync-upstream --preview-only --verbose   # 先看完整清单
sync-upstream                            # 再真正执行
```

也可以一条命令搞定，不写配置文件：

```bash
sync-upstream -r https://github.com/vuejs/core.git \
  -d packages/runtime-core,packages/shared \
  -b main -c company/main -P
```

## 按你的情况读

- 先判断该不该用：[与 fork 同步的对比](/guide/vs-fork-sync)
- 第一次跑通：[快速开始](/guide/quick-start) → [使用总览](/guide/usage) → [日常同步](/guide/sync-basics)
- 卡住了：[常见问题](/faq) · [退出码与日志](/guide/automation#退出码)
- 专项：[冲突处理](/guide/conflicts) · [灰度发布与回滚](/guide/gray-release) · [Webhook 守护模式](/guide/webhook) · [CI 与自动化](/guide/automation)
- 逐项查：[命令行参考](/reference/cli) · [配置参考](/reference/configuration) · [API 参考](/reference/api)
- 项目：[安装指南](/guide/installation) · [配置指南](/guide/configuration) · [功能记录](/features) · [更新日志](/changelog)

## 运行前提

- 当前目录已经是一个 Git 仓库（`git init` 即可），目标分支已存在
- 对上游仓库有读取权限，对目标分支有写入权限（只在 `--push` 时需要）
- Node.js ≥ 18.2、Git ≥ 2.25
