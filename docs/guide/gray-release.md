# 灰度发布与回滚

灰度做的是同一件事两次：**先把计划裁剪成一个子集发布，验证过了再发剩下的**。它复用的就是普通同步流水线，只是把"计划"换成"金丝雀计划"，并把阶段写进状态文件。

## 最小流程

```bash
# 1) 先发 20%（CLI 的 --percentage 默认值就是 20）
sync-upstream -gr --percentage 20 -V

# 2) 验证通过后，发布剩下的
sync-upstream -gr --full-release

# 或者发现问题，回到灰度之前
sync-upstream -gr --rollback
```

`-gr` 只负责打开开关（等价于 `grayReleaseConfig.enable: true`），选择规则由 `--strategy` / `--percentage` / `--canary-dirs` / `--file-patterns` 给出。

## 三种选择策略

| 策略 | 选择依据 | 需要字段 | 校验 |
|---|---|---|---|
| `percentage`（默认） | 按路径做确定性分桶：同一条路径每次都落在同一个桶里，桶号 `< percentage` 即入选 | `percentage` ∈ `(0, 100]` | 缺失/非数字/越界直接报错 |
| `directory` | 变更所属的同步目录命中 `canaryDirs`，按前缀匹配 | `canaryDirs` 非空 | 空列表直接报错 |
| `file` | 路径匹配 `filePatterns` | `filePatterns` 非空 | 空列表直接报错 |

`file` 模式的匹配规则不是 glob，就三条：含 `/` 的模式按"路径后缀"匹配（可省略前导 `/`）；`*.ext` 按文件名后缀匹配；其余按文件名精确相等。

**分桶是确定性的**：同一份计划重跑会选到同一批文件，所以第一次没发完、第二次接着发，金丝雀集合不会漂移。

## 阶段机

```
idle → canary → validating → completed
                           ↘ failed →（可选 rollbackOnFailure）→ rolled-back
```

| 阶段 | 何时进入 | 干了什么 |
|---|---|---|
| `canary` | 应用变更之前 | 写 `.sync-gray.json`：`releaseId`、基线提交 `baseCommit`、canary 与 pending 路径 |
| `validating` | 应用完成、进入校验时 | 若配了 `validationScript` 就跑校验（带重试与超时） |
| `completed` | 校验通过或未配校验 | 全量发布时清空状态文件，金丝雀阶段时保留 pending 列表 |
| `failed` | 校验不通过 | 记录错误并审计；`rollbackOnFailure` 为真则继续回滚 |
| `rolled-back` | 回滚完成 | 记录回滚提交 |

进度按实际数字算：`filesReleased / totalFiles`，`completed` 固定 100%。旧版因为读了个不存在的配置键，每次选 0 个文件、进度永远 0%，现在的行为是**选不出金丝雀就直接报错**：

```
灰度选择结果为空：当前计划没有任何文件落入金丝雀集合，请调整 percentage/canaryDirs/filePatterns
```

`releaseId` 形如 `md9k2z1-3f7a1c`（时间戳 36 进制 + 3 字节随机数），每次重新选择都会生成新的。

## 配置样例

```json
{
  "grayReleaseConfig": {
    "enable": true,
    "strategy": "directory",
    "canaryDirs": ["packages/shared"],
    "validationScript": "pnpm typecheck",
    "maxRetries": 2,
    "rollbackOnFailure": true,
    "auditLogPath": ".sync-gray-audit.jsonl"
  }
}
```

校验命令的行为：在仓库根以 shell 方式执行，退出码非 0 即失败；单次最多运行 120 秒，超时会被中止；总尝试次数 = `maxRetries + 1`（`maxRetries` 缺省按 0）；输出最多保留 4000 字符。失败是一次发布的结论，不是异常，所以不会中断进程。

可选的看门狗（只在 `enableMonitoring: true` 时启动）：

```json
{
  "grayReleaseConfig": {
    "enable": true,
    "enableMonitoring": true,
    "monitorInterval": 5000,
    "alertThresholds": { "errorRate": 10, "maxExecutionTime": 300 }
  }
}
```

看门狗不会拖住进程退出，也可以显式停止。它**只打印 `[灰度告警]` 警告，不会自动判定失败**；`alertThresholds.performanceDrop` 目前未生效。

## 回滚做了什么

`--rollback` 依据 `.sync-gray.json` 里的 `baseCommit`，把"曾经发布过的路径"逐个还原：

- 基线里存在的 → 从 `baseCommit` checkout 回来
- 基线里不存在（即那次发布新建的）→ `git rm` 删掉
- 差异非空则提交一条 `chore(sync): rollback gray release <releaseId>`

三种情况不会回滚，只记原因：找不到 `baseCommit`（"找不到灰度起始版本，无法回滚"）、没记录到已发布文件、还原后与起始版本一致（"回滚未产生差异"）。

`--rollback` 必须与 `-gr` 同时使用，因为回滚入口在灰度控制器里；单独 `sync-upstream -ro` 会报 `--rollback 需要同时启用 grayReleaseConfig`。

## 生命周期

`.sync-gray.json` 只在**全量发布成功**时被自动删除。金丝雀完成、校验失败、回滚之后文件都会保留，阶段分别记为 `canary`/`failed`/`rolled-back`，因此下一次 `-gr` 运行会接着同一份记录（前提仍是仓库、两侧分支与策略四项一致）。

`--full-release` 与 `--rollback` 完全依赖 `.sync-gray.json`（剩下的文件是哪些、发布前长什么样）：灰度进行中删掉它就只能手工 `git revert` / `git checkout` 收尾。`.sync-gray-audit.jsonl` 只是记录，丢了不影响接续。字段与清理建议见 [运行产物与清理](/reference/configuration#运行产物与清理)。

## 与普通同步的差别

| | 普通同步 | 灰度同步 |
|---|---|---|
| 计划 | 全量计划 | 按策略筛出的子集 |
| 提交 | 一次 | 金丝雀一次、全量再一次（回滚还可能多一次） |
| 状态 | `.sync-state.json` | 外加 `.sync-gray.json` + 审计 |
| 失败处理 | 报错退出 | 记 `failed` 阶段，可选自动回滚 |

## 相关页面

- 参数：[命令行参考](/reference/cli) · [配置参考 grayReleaseConfig](/reference/configuration#grayreleaseconfig)
- 冲突与灰度同时启用时：[冲突处理](/guide/conflicts)
- 编程接口：[API 参考的灰度小节](/reference/api#灰度-api)
