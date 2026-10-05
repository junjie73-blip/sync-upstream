# CI 与自动化

脚本化使用的四件事：怎么让它不提问、怎么看退出码、怎么看日志、失败了怎么重来。

## 在 CI 里跑

```yaml
- name: Sync upstream
  env:
    UPSTREAM_TOKEN: ${{ secrets.UPSTREAM_READ_TOKEN }}
  run: |
    npx sync-upstream -C sync-upstream.config.json -y \
      --auth-type pat --auth-token "$UPSTREAM_TOKEN" \
      --conflict-strategy keep-target
```

要点：

- **`-y` 只在配置完整时保证零提问**：`upstreamRepo` 或 `syncDirs` 缺失时仍会进入交互补全，CI 里务必用配置文件或 `-r`/`-d` 补齐
- 凭据必须由 CI 展开成参数或写进生成的配置文件——工具不读任何环境变量
- 用 `--conflict-strategy` 显式指定策略，别依赖 `-y` 把 `prompt-user` 降级成"保留本地"
- 先跑一次 `-P -V` 把计划打进日志，再跑真实同步，出问题时日志能对上号

只想检查"上游有没有新东西"而不落地，用预览 + 计划计数：

```bash
npx sync-upstream -C sync-upstream.config.json -y -P | tee sync-plan.txt
grep -q "计划: 0 项变更" sync-plan.txt && echo "up to date"
```

## 退出码

| 码 | 含义 | 建议处理 |
|---|---|---|
| 0 | 成功（含"无变更可提交"、预览运行、交互取消） | 继续 |
| 1 | 未预期错误，或部分文件应用失败 | 看日志里的 `x <路径>` 行 |
| 2 | 配置/校验失败、未知命令行参数 | 修配置或参数 |
| 3 | git 操作失败（fetch、checkout、push、引用不存在、分支缺失） | 查凭据与分支 |
| 4 | 用户取消 | 保留码：当前交互取消直接以 0 结束，不会返回 4 |

退出码按错误类别映射：配置与参数问题 → 2，git 操作失败 → 3，其余一切（认证失败、网络抖动、超时、未预期错误）→ 1。部分文件应用失败不算异常，而是结果判定：只要本次有路径失败就返回 1。

## 日志

```bash
sync-upstream -V    # 放开日志级别，并列出完整变更清单
sync-upstream -s    # 只保留错误输出
```

| 开关 | 日志级别 | 计划列表 |
|---|---|---|
| 默认 | info / success / warn / error | 前 40 条，多余部分提示"完整列表见 --verbose" |
| `-V` / `--verbose` | 再加 verbose | 全部路径 |
| `-s` / `--silent` | 仅 error | 不打印 |

两个容易误解的点：

- **`-V` 不会打开 debug**。debug 目前只用于逐条打印 `冲突已解决: 路径 → 动作`，命令行没有任何开关能把级别降到 debug，只有以库方式使用时才看得到（见 [API 参考](/reference/api)）。
- **计划条数上限看的是配置里的 `verbose`，日志级别看的是命令行**。所以在配置文件里写 `"verbose": true` 会让计划打印全部路径，但日志级别仍是 info；反过来 `-V` 同时设置两者。

`-V` 与 `-s` 同时给时 `-V` 生效。`-s` 下错误与失败路径仍会打印，进度类信息全部静默，适合脚本抓取。配置摘要（上游、分支、同步目录、重试、冲突策略等）用 info 级别打印，因此 `-s` 下不出现。

## 并发与重试

两个数字管两件不同的事，容易混淆：

| 配置 | 默认 | 实际作用范围 |
|---|---|---|
| `concurrencyLimit`（`--concurrency`） | 10 | **只**在"整批应用失败、改用逐条重试"时起作用：同时处理的路径数上限，单条失败不影响其他条。整批一次成功时不涉及并发 |
| `retryConfig`（`--retry-max` / `--retry-delay` / `--retry-backoff`） | 3 次 / 2000ms / 1.5 | **只**作用于"拉取上游分支"这一步，且只对"像网络问题"的失败重试 |

重试延迟为 `initialDelay × backoffFactor^(n-1)`（四舍五入到毫秒）；只有失败信息里带有网络类特征（`网络`、`network`、`connect`、`resolve host`、`timed out`、`timeout`、`RPC failed`、`early EOF`、`The remote end`）才会重试。非网络错误（认证失败、分支不存在）第一次就失败，不浪费重试。重试耗尽后错误原样上报，消息里会带"超时"或网络相关字样，退出码都是 1。

应用文件、删除文件、提交、推送都不会自动重试——它们的失败要么立刻可判定，要么需要人来处理。推送失败时提交已经在本地，重跑或手工 `git push` 都行。

## 失败了怎么干净重来

```bash
git status --short             # 看工作区现状
git log --oneline -3           # 看是不是已经提交了
rm -f .sync-state.json         # 丢掉"已同步"记录，下次全量比对
rm -f .sync-gray.json .sync-gray-audit.jsonl   # 只有不需要回滚灰度时才删
```

工具留下的东西都是有界的：三个状态文件、一个名为 `sync-upstream` 的 remote、目标分支上的若干提交。`origin` 不会被改写，同步目录之外不会被碰。具体报错怎么读见 [常见问题](/faq#故障排查)。

## 单文件与局部同步

`syncDirs` 支持直接写文件路径（`["package.json"]`），也支持"目录 + 过滤"：

```json
{
  "syncDirs": ["packages/shared"],
  "includeFileTypes": [".ts"],
  "ignorePatterns": ["**/__tests__/**", "**/*.spec.ts"]
}
```

求值顺序与 gitignore 一致：后加入者胜出。忽略规则的分层与解释见 [配置文件](/guide/configuration#忽略规则放哪里)。

## 相关页面

- [命令行参考](/reference/cli) · [配置参考](/reference/configuration)
- [使用总览](/guide/usage)：为什么预览与提交一定一致
- [运行产物与清理](/reference/configuration#运行产物与清理)：哪些文件可以安全删除
