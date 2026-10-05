# 冲突处理

冲突的定义很窄：**上游要动这个文件，而你本地（工作区）也动过它**。计划阶段挑出来，应用阶段按策略处置，全程不需要你手工比对文件。

## 会产生哪几类冲突

冲突类型共有 7 种，实际会出现的是前 4 种：

| 类型 | 触发条件 | 状态 |
|---|---|---|
| `content` | 上游要修改该文件，且该文件在本地有未提交的改动 | 会出现 |
| `delete-modify` | 上游删除该文件，而你本地改过它 | 会出现 |
| `untracked-overwrite` | 上游新增该文件，而你工作区里有个同路径的未跟踪文件 | 会出现 |
| `type` | 同一路径一侧是文件、另一侧是目录 | 会出现 |
| `add-add` | —— | 预留，不会出现（同路径未跟踪新增按 `untracked-overwrite` 处理） |
| `symlink` | —— | 预留，不会出现（符号链接差异按 `content` 处理） |
| `unreadable` | —— | 预留，不会出现（读不了的文件按"那一侧没有这个文件"处理） |

当目标分支与上游没有共同历史时，自动合并无法区分哪一侧才是"原样"，两侧都会被视为改动，更容易产生冲突标记。

## 五种解决策略

```bash
sync-upstream --conflict-strategy prompt-user   # 逐个文件询问（默认）
sync-upstream --conflict-strategy use-source    # 一律采用上游
sync-upstream --conflict-strategy keep-target   # 一律保留本地
sync-upstream --conflict-strategy auto-merge    # 三方合并，合不动的写冲突标记
sync-upstream --conflict-strategy skip          # 跳过冲突文件
```

| 策略 | 对应动作 | 说明 |
|---|---|---|
| `prompt-user` | 取决于选择 | 每个冲突文件至多询问一次；未选择或按 `Ctrl+C` 都按保留本地处理，不会重复弹问 |
| `use-source` | `take-upstream` | 直接用上游内容覆盖 |
| `keep-target` | `keep-local` | 保留本地，应用阶段把这条记为"保留本地"，不写入也不删除 |
| `auto-merge` | `take-upstream` / `keep-local` / `write-merged` / `skip` | 见下节 |
| `skip` | `skip` | 整文件不动 |

非法策略值（比如把 `keep-target` 拼错）会直接报错终止整次运行（退出码 2），而不是悄悄回落默认值。

## auto-merge 怎么合

auto-merge 对文本文件做行级三方合并：比对本地当前内容、上游内容，以及两者共同的历史版本。

| 情形 | 结论 |
|---|---|
| 两侧一致，或只有一侧有改动 | 自动采用改动的那一侧 |
| 两侧都改动且改到同一区域 | 写入标准冲突标记（日志会给出冲突区块数） |
| 一侧删除、另一侧修改 | 写入标准冲突标记 |
| 两侧都删除 | 跳过该文件 |
| 任一侧是二进制文件 | 跳过该文件（"二进制文件无法自动合并"） |

冲突标记长这样，文件会**带着标记写入并暂存**，需要你手工收尾后再提交：

```text
<<<<<<< LOCAL
你的版本
=======
上游版本
>>>>>>> UPSTREAM
```

自动合并有大文件保护：参与合并的任一版本超过约 20 000 行，或差异区域过大时，不再逐行合并，直接写入包裹整个文件的冲突标记，避免长时间卡顿。

## 按扩展名放行

不想全局降级策略时，用 `autoResolveTypes` 让特定扩展名**不参与提问**：

```json
{
  "conflictResolutionConfig": {
    "defaultStrategy": "prompt-user",
    "autoResolveTypes": [".md"],
    "logResolutions": true
  }
}
```

注意语义：在 `prompt-user` 下，命中 `autoResolveTypes` 的文件直接**保留本地**（保守选择），不是自动合并。想要"这些扩展名自动合并"，请把 `defaultStrategy` 设为 `auto-merge`。

`logResolutions` 默认开启，每条决策以 debug 级别打印 `冲突已解决: <路径> → <动作>`；`-V` 能看到全部。`resolutionLogFile` 配置项目前不生效（不会写独立的决策日志文件）。

## 单文件失败不会拖累整批

某个冲突文件在读取或合并时出错，只会被记为 `skip` 并附带原因（`处理失败: <消息>`），同批其他冲突继续处理。唯一的例外是策略值非法——那是配置错误，整次运行必须失败。

## 非交互模式下的行为

`-y` 且 `defaultStrategy` 是 `prompt-user` 时，运行前会打印警告并把策略改成 `keep-target`：

```text
 WARN  非交互式模式：2 个冲突文件按保留本地处理（用 conflictResolutionConfig.defaultStrategy 改变该行为）
```

CI 里更常见的写法是直接指定策略：

```bash
sync-upstream -y --conflict-strategy auto-merge
```

## 相关页面

- 编程接口：[API 参考的冲突小节](/reference/api#冲突-api)
- 字段说明：[配置参考的 conflictResolutionConfig](/reference/configuration)
