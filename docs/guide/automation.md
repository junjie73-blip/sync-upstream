# CI 与自动化

脚本化使用的几件事：怎么让它不提问、怎么看退出码与机器输出、日志落在哪里、失败了怎么重来、通知怎么发出去。

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
- 凭据必须由 CI 展开成参数或写进生成的配置文件——工具只读这几个环境变量：`SYNC_UPSTREAM_LANG`、`LC_ALL`、`LANG`、`LANGUAGE`（判定输出语言）、`GITHUB_STEP_SUMMARY`（写 CI 摘要）、`SYNC_UPSTREAM_PR_CREATE=0`（跳过自动创建 PR），凭据一律不读
- 用 `--conflict-strategy` 显式指定策略，别依赖 `-y` 把 `prompt-user` 降级成"保留本地"
- 先跑一次 `-P -V` 把计划打进日志，再跑真实同步，出问题时日志能对上号
- `init` 需要交互终端：带 `--json`、带 `-y`，或根本没有 tty（CI 里就是这样）时都会被拒绝，退出码 2，并提示改用 `--generate-config` 生成模板后手工编辑
- 定时任务与 CI 并发时留好退路：抢不到仓库锁会立刻失败（退出码 5），需要排队就加 `--lock-wait`，见 [并发与重试](#并发与重试)

只想检查"上游有没有新东西"而不落地，用预览 + 计划计数：

```bash
npx sync-upstream -C sync-upstream.config.json -y -P | tee sync-plan.txt
grep -q "计划: 0 项变更" sync-plan.txt && echo "up to date"
```

更省事的是只读子命令：`sync-upstream status --json` 给出待同步计数，`sync-upstream doctor --json` 给出配置与环境体检，两者都不会改工作区。

## 机器可读输出

```bash
sync-upstream --json -y        # stdout 只有一个 JSON 文档
sync-upstream status --json
sync-upstream why packages/shared/src/const.ts --json
sync-upstream doctor --json
sync-upstream history --limit 50 --json
```

- stdout 是**一份完整 JSON 文档**（不是逐行流），颜色码已被剥掉，可以直接 `| jq`
- `--json` 会把控制台日志压到 error 级别，否则日志会混进管道；错误与报告里的 `warnings` 才是你要读的东西
- 顶层固定是 `command` / `ok` / `exitCode` / `generatedAt` / `data` / `warnings`（同步与撤销另有 `summary`），字段含义见 [CLI 参考](/reference/cli)
- `--json` 之下没有任何提问：`deletePolicy: ask` 按保留处理，`prompt-user` 冲突按保留本地处理
- GitHub Actions 里，同步、`status`、`doctor` 会把同一份内容以 markdown 追加到 `$GITHUB_STEP_SUMMARY`，不需要额外步骤；写不进去只会多一条 warning，不影响退出码

```bash
sync-upstream --json -y | jq -r '.data.commit.hash // "no commit"'
```

## 退出码

| 码 | 含义 | 建议处理 |
|---|---|---|
| 0 | 成功（含"无变更可提交"、预览运行；同步过程中的取消按保留本地处理，收尾后仍是 0） | 继续 |
| 1 | 未预期错误，或部分文件应用失败；`--undo` 无内容可撤销 | 看日志里的 `x <路径>` 行 |
| 2 | 配置/校验失败、未知命令行参数、`init` 缺少交互终端、多上游配了灰度 | 修配置或参数 |
| 3 | git 操作失败（fetch、checkout、push、引用不存在、分支缺失） | 查凭据与分支 |
| 4 | 用户在 `sync-upstream init` 的问答里取消（`Ctrl+C` 或选择取消） | 视为放弃这次初始化；同步流程的取消不会走到这里 |
| 5 | 仓库锁被另一次同步占用（`--lock-wait` 也没等到） | 改时间错开，或给定时任务加 `--lock-wait` |

退出码按错误类别映射：配置与参数问题 → 2，git 操作失败 → 3，仓库锁拿不到 → 5，其余一切（认证失败、网络抖动、超时、未预期错误）→ 1。部分文件应用失败不算异常，而是结果判定：只要本次有路径失败就返回 1。

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

## 日志落盘与滚动

守护进程和复用同一台 runner 的 CI 需要留下痕迹，`logConfig`（`--log-file`）就是为此：每一行日志在打到终端的同时追加进一个文件。

```bash
sync-upstream --log-file logs/sync.log --log-level info --log-max 2097152 --log-keep 10
sync-upstream --log-file sync.jsonl --log-json    # 一行一个 JSON 对象，方便日志采集
```

- `--log-file` 是开关：不给就只打终端（0.2 及之前的行为）；相对路径按当前工作目录解析，目录不存在会自动创建
- `--log-level` 只管文件那一边，可写 `debug`/`info`/`warn`/`error`，默认 `info`；终端级别仍由 `-V`/`-s` 决定
- **文件不受 `-s` 影响**：`--silent` 是不想让输出刷屏，不是不想留记录，否则半夜退出的守护进程和从没启动的守护进程在日志里长得一模一样
- 滚动按体积触发：默认单文件 5 MiB（`--log-max`），满了就把 `<file>` 挪成 `<file>.1`，`<file>.1` 挪成 `<file>.2`……最旧的 `--log-keep`（默认 5）份之外的那份被丢弃；`--log-keep 0` 表示不留历史，直接重开
- 颜色码与凭据在写入前就被抹掉：URL 里的用户名密码、`token=`、`Bearer …` 都会打码，webhook secret 与 `logConfig.redact` 列出的字符串也一并处理
- 日志文件写失败只会在 stderr 提示一次 `[LOG] 写入日志文件 … 失败: …`，不会影响本次同步与退出码

`--log-json` 与 `--json` 是两件不同的事：前者决定磁盘上的文件长什么样，后者决定 stdout 是不是一个 JSON 报告。

## 通知钩子

`notifyConfig.enable` 打开后，同步的结果会推给聊天工具或一个 HTTP 端点。默认关心的事件是 `success`、`conflict`、`failure`、`undo` 四类；空跑（计划为 0）默认**不发**，否则繁忙仓库上的守护进程会为每次推送都发一条。

```json
{
  "notifyConfig": {
    "enable": true,
    "channels": ["slack", "dingtalk"],
    "slackUrl": "https://hooks.slack.com/services/xxx",
    "dingtalkUrl": "https://oapi.dingtalk.com/robot/send?access_token=xxx",
    "dingtalkSecret": "SEC...",
    "events": ["success", "conflict", "failure"]
  }
}
```

```bash
sync-upstream --notify stdout            # 只把通知内容打进日志，先看看长什么样
sync-upstream --notify http --notify-url https://example.com/hook
sync-upstream --notify-events success,failure
sync-upstream -y --no-notify             # 这次运行一条都不发
```

- 通道有 `stdout`、`http`、`slack`、`dingtalk`、`wecom` 五种；缺对应 URL 的通道会被跳过，不算错误
- 机器人地址是凭据，写在配置或环境注入后的配置文件里，别放到命令行上（`--notify-url` 是给 CI 临时接回调用的例外）
- 钉钉机器人开了"加签"却没写 `dingtalkSecret`，投递会被拒，工具会先警告这一条
- 每次请求默认 5000ms 超时（`timeoutMs`），每个通道默认共尝试 2 次（`retries`），两次之间隔多久由 `notifyConfig.retryConfig.initialDelay` 决定，没写时是 500ms（注意这不是同步用的顶层 `retryConfig`，那个默认 2000ms）；提供方挂了只会在日志里留一行 `通知 slack 失败: …`，不会影响同步结果或退出码
- `template` 可以定制文案，可用占位符：`{outcome}` `{upstream}` `{upstreamBranch}` `{companyBranch}` `{commit}` `{files}` `{kept}` `{conflicts}` `{skipped}` `{error}` `{duration}`；`includeDetails: false` 去掉逐文件摘要，通知里最多带几个示例路径
- 预览运行不发通知；守护进程重试三次也只会在最后 announce 一次

## 并发与重试

三个数字管三件不同的事，容易混淆：

| 配置 | 默认 | 实际作用范围 |
|---|---|---|
| `concurrencyLimit`（`--concurrency`） | 10 | **只**在"整批应用失败、改用逐条重试"时起作用：同时处理的路径数上限，单条失败不影响其他条。整批一次成功时不涉及并发 |
| `retryConfig`（`--retry-max` / `--retry-delay` / `--retry-backoff`） | 3 次 / 2000ms / 1.5 | **只**作用于"拉取上游分支"这一步，且只对"像网络问题"的失败重试 |
| `lockWaitMs`（`--lock-wait`） | `0` | 等别的运行释放仓库锁的毫秒上限，`0` 表示被占用就立刻失败（退出码 5）。它管的是"同一工作区同时只能有一次同步"，与前两行无关 |

重试延迟为 `initialDelay × backoffFactor^(n-1)`（四舍五入到毫秒）；只有失败信息里带有网络类特征（`网络`、`network`、`connect`、`resolve host`、`timed out`、`timeout`、`reset`、`closed`、`RPC failed`、`early EOF`、`无法访问`、`不可达`）才会重试。非网络错误（认证失败、分支不存在）第一次就失败，不浪费重试。重试耗尽后错误原样上报，消息里会带"超时"或网络相关字样，退出码都是 1。

应用文件、删除文件、提交、推送都不会自动重试——它们的失败要么立刻可判定，要么需要人来处理。推送失败时提交已经在本地，重跑或手工 `git push` 都行。

### 仓库锁与定时任务

cron 与 webhook 撞车的结果不是"报错两次"，而是两次交错提交，所以每次运行（含预览）都会独占 `.git/sync-upstream.lock`：

- 默认 `lockWaitMs: 0`，抢不到就以退出码 5 失败。定时任务里建议按"跑得完的时间"给 `--lock-wait`，比如 `--lock-wait 300000`；等待期间每 200ms 重试一次
- 持锁进程已退出、或锁龄超过 30 分钟会被自动接管，并打印一条 `发现过期锁…接管` 警告；也就是说崩溃不需要人工清锁，除非锁龄不到 30 分钟又确认对方已经死了
- 守护进程的投递队列在本进程内串行（见 [Webhook 守护](/guide/webhook)），但跨进程、跨机器的并发只能靠这把锁
- 锁不解决"两个 runner 推同一个分支"这种问题：那要靠 CI 侧的并发组，或者错开定时时间

## 失败了怎么干净重来

```bash
git status --short             # 看工作区现状
git log --oneline -3           # 看是不是已经提交了
sync-upstream history          # 这个工具记下的历次同步 commit
sync-upstream --undo           # 最近一次同步是个提交，直接撤销
rm -f .sync-state.json         # 丢掉"已同步"记录，下次全量比对
rm -f .sync-gray.json .sync-gray-audit.jsonl   # 只有不需要回滚灰度时才删
```

`--undo` 之后（或它因为 HEAD 已经移动而拒绝执行、你自己 `git revert` 之后）才需要动状态文件。工具留下的东西都是有界的：状态文件（多上游时每个来源一份 `.sync-state-*.json`）、同步历史、名为 `sync-upstream` 的 remote（多上游时还有 `sync-upstream-2`…）、目标分支上的若干提交、`.git/sync-upstream.lock`、可选的日志文件与 webhook 投递日志。`origin` 不会被改写，同步目录之外不会被碰。具体报错怎么读见 [常见问题](/faq#故障排查)。

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
- [日常同步 → 同一个仓库同时只能跑一次](/guide/sync-basics#同一个仓库同时只能跑一次) · [撤销最近一次同步](/guide/sync-basics#撤销最近一次同步)
- [Webhook 守护](/guide/webhook)：常驻进程的队列、限流与投递日志
