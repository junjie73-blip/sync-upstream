# 与 GitHub / Gitee 自带 fork 同步的对比

这个页面回答一个很常见的问题：**上游都在 GitHub / Gitee 上，"Fetch upstream" 一个按钮就能同步，为什么还要一个命令行工具？**

先给结论，再给例子。

> 结论：**如果只是偶尔把 fork 的默认分支整体更新到上游最新，自带功能更省事**——一次点击、零配置、不需要装任何东西。这个工具不打算替代那一步。
>
> 它解决的是自带功能做不到的那类需求：**只要上游的几个目录，同时保住自己在其余目录里的定制。**

下面的命令都假设 `upstreamRepo` / `companyBranch` 已在配置文件里写好，用 `-d` 覆盖作用域；从零开始的写法见[快速开始](/guide/quick-start)。

---

## 例子 1：只要上游的一个目录

公司仓库 `acme/core` 是 `vuejs/core` 的 fork，只想跟 `packages/runtime-core`，`apps/`、`examples/`、`packages/compiler-*` 全是我们自己改过的。

自带 fork 同步做的事：把上游 `main` 的全部改动合并进来。上游这次动了 800 个文件，其中 6 个落在我们定制的目录里 —— 于是我们要为这 6 个文件解冲突，而这 6 个文件根本是这次不想碰的。

本工具做的事：

```bash
sync-upstream -r https://github.com/vuejs/core.git -b main \
  -d packages/runtime-core -c company/main --preview-only
```

范围外的文件不读、不改、不提交。计划里出现的每一条路径，就是最终提交里出现的路径。

`syncDirs` 允许写到单个文件：

```json
{ "syncDirs": ["packages/runtime-core", "packages/shared/patchFlags.ts"] }
```

---

## 例子 2：得先看清楚要改什么，再决定合不合

自带功能没有"预览"。它要么合并，要么不合并。

本工具把计划先打印出来：

```text
计划: 4 项变更 (源 refs/remotes/sync-upstream/main → 目标 company/main)
~ packages/runtime-core/src/renderer.ts (packages/runtime-core)
~ packages/runtime-core/src/component.ts (packages/runtime-core)
+ packages/runtime-core/src/rendererTemplateRef.ts (packages/runtime-core)
- packages/runtime-core/src/oldScheduler.ts (packages/runtime-core)
冲突: 1 个文件本地与上游都有改动
  ! packages/runtime-core/src/component.ts [content]
```

（`~`/`+`/`-` 分别是修改 / 新增 / 删除，括号里是命中的作用域；超过 40 条时默认只列前 40 条，`-V` 打印完整清单。）

预览不切分支、不动 HEAD、不产生提交（仍会确保 remote 并 fetch 一次，这是只读操作）。确认无误后去掉 `--preview-only` 再跑。

---

## 例子 3：冲突有策略，不是只有"手工解"

上游改了 `src/component.ts`，我们也在同一处改了。自带功能把这个文件交给 git 默认 merge，冲突标记落在工作区，得人肉处理。

本工具按策略处理：

```bash
# 这个目录一律以上游为准
sync-upstream -d packages/runtime-core --conflict-strategy use-source

# CI 上永不提问，冲突一律保留本地
sync-upstream -d packages/runtime-core -y --conflict-strategy keep-target
```

`auto-merge` 走真正的三方合并（以两边的共同祖先版本为基准），合不上才写冲突标记；二进制文件和双方都删的情况单独标记为 `skip`，不影响同批其他文件。

---

## 例子 4：改动太大，要分批上线

上游一次性重构了 200 个文件。自带功能是全有或全无。

本工具可以先发 20%，跑校验脚本，通过再补齐：

```bash
sync-upstream -gr --percentage 20 --validation-script "pnpm test"   # 金丝雀
sync-upstream -fr                                                   # 校验通过后补齐
sync-upstream -ro                                                   # 或只退回已经发过的那批
```

回退是新提交一条回滚提交（内容回到灰度基线），不是 `git reset`，因此已推送的历史不会被改写。

---

## 例子 5：目标分支不是默认分支

自带同步基本只对着默认分支；Gitee 在 fork 分支上有本地独立提交时还会直接不可用。

我们有 `company/main`、`company/release-5.2`、`company/hotfix-2026-03` 三条内部分支都要跟上游。本工具用 `-c` 指定任意目标分支，配 CI matrix 就是三条分支一条命令各跑一遍。

---

## 例子 6：定时与事件触发

点击式同步做不到"每天凌晨 3 点跟一次上游，失败就报警"。

```yaml
# .github/workflows/sync.yml
- run: npx sync-upstream -C sync-upstream.config.json -y
```

也可以常驻监听上游推送：

```bash
sync-upstream -we --webhook-secret "$WH_SECRET" --webhook-branch main
```

（`$WH_SECRET` 由 shell 展开后代入——工具本身不读任何环境变量。）

---

## 什么时候不该用它

| 需求 | 用什么 |
|---|---|
| 一键把 fork 的默认分支更到上游最新 | 自带 "Fetch upstream" / Sync fork |
| 需要保留上游的提交历史与 merge 关系 | `git merge upstream/main` |
| 需要线性历史、rebase 上游提交 | `git rebase` |
| 想把上游改动开成 PR 给自己审 | `git merge --no-commit` 后手工整理 |
| 只跟指定目录，且要保住其余目录的定制 | 本工具 |
| 只跟指定目录，且要预览 / 分批 / 回滚 / 定时 | 本工具 |

一个原理性差别值得记住：**本工具同步的是内容，不是历史**。它产生的是一条普通提交，把作用域内的文件对齐到上游那个提交的状态；上游的 commit 图不会被搬进你的仓库。要保留历史脉络，`git merge` 才是对的工具。

---

## 相关页面

- [使用总览](/guide/usage) —— 一次运行的完整流程
- [日常同步](/guide/sync-basics) —— 作用域与预览
- [冲突处理](/guide/conflicts) —— 4 类冲突与 5 种策略
- [灰度发布与回滚](/guide/gray-release) —— 分批上线
- [CI 与自动化](/guide/automation) —— 定时与无人值守
- [CLI 参考](/reference/cli) —— 全部参数
- [常见问题](/faq)
