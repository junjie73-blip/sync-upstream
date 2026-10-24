# Webhook 守护模式

`--webhook-enable` 让工具常驻为一个 HTTP 服务：收到推送事件 → 校验通过 → 立刻应答 → 后台跑一次同步。它是普通流水线外加的一层薄壳，同步逻辑完全复用。

## 启动

```bash
sync-upstream -we --webhook-secret "$SYNC_WEBHOOK_SECRET" --webhook-port 3000
sync-upstream -we --webhook-host 0.0.0.0 --webhook-log var/log/deliveries.jsonl
sync-upstream -we --webhook-port 0 --webhook-queue 16        # 随机端口，队列放宽到 16
```

```text
Webhook 服务已启动: http://127.0.0.1:3000/webhook（Ctrl+C 退出）
投递决定写入 /abs/path/var/log/deliveries.jsonl
```

- **默认只绑 `127.0.0.1`**（`host`，`--webhook-host`）：一个默认监听所有网卡的同步守护进程，就是内网仓库被全网络访问的方式。公网/容器里要显式写 `"0.0.0.0"`
- `port: 0`（`--webhook-port 0`）由系统分配端口，横幅打印的是**实际绑定到的**地址与端口
- 给了 `tlsCert` + `tlsKey`（两个 PEM 路径，必须成对）就是 HTTPS，横幅里的协议随之变成 `https://`
- 设了 `logConfig.file` 会多打一行"日志同时写入 …"，投递决定与在途同步的成败都会留在文件里
- 没设 `deliveryLog` 会警告一句"未设置 webhookConfig.deliveryLog：投递决定只出现在控制台，进程退出后无从回看"

守护模式下的每次同步都会强制 `nonInteractive: true`（所以 `prompt-user` 冲突策略自动变成保留本地），`autoPush` 仍按配置生效；同步失败只记日志，服务不会退出。网络类失败会按 `webhookConfig.retryConfig`（没写则用顶层 `retryConfig`）重试，重试耗尽才发一条通知。

`Ctrl+C` / `SIGTERM` 的退出顺序是先停止接收、再等在途同步跑完：期间新请求得到 `503 服务正在退出，请重新投递`，日志依次打印 `Webhook 监听已关闭，等待在途同步完成…`、`Webhook 服务器已停止`。进程级的未处理异常与 Promise 拒绝也只记录不退出——一个不再应答的守护进程比一个失败的投递更难发现。

## 配置

```json
{
  "webhookConfig": {
    "enable": true,
    "host": "127.0.0.1",
    "port": 3000,
    "path": "/webhook",
    "secret": "从部署环境变量注入，不要提交进仓库",
    "allowedEvents": ["push"],
    "triggerBranch": "main",
    "supportedPlatforms": ["github", "gitlab"],
    "healthPath": "/healthz",
    "maxBodyBytes": 1048576,
    "trustProxy": false,
    "deduplicate": true,
    "deliveryLog": "var/log/sync-deliveries.jsonl",
    "maxQueue": 8,
    "retryConfig": { "maxRetries": 3, "initialDelay": 2000 },
    "securityConfig": {
      "ipWhitelist": ["10.0.0.0/8", "203.0.113.7"],
      "rateLimit": { "maxRequestsPerSecond": 5, "statusCode": 429, "message": "too fast" }
    },
    "eventFilterConfig": {
      "rules": [
        {
          "eventType": "push",
          "conditions": [{ "fieldPath": "ref", "operator": "eq", "value": "refs/heads/main" }]
        }
      ]
    }
  }
}
```

注意：工具**不会因为读环境变量而改变行为**，`--webhook-secret "$SYNC_WEBHOOK_SECRET"` 里的值是由 shell 展开后代入的（只有 `SYNC_UPSTREAM_LANG`、`LC_ALL`、`LANG`、`LANGUAGE`、`GITHUB_STEP_SUMMARY` 这几个例外，见 [CI 与自动化](/guide/automation)）。配置文件里同样只能写字面值，或由 CI 生成文件。

`-we` 会把 `supportedPlatforms` 写成 `github、gitlab、bitbucket、gitea` 四个（数组整体替换，配置文件里的平台列表会被它盖掉）。平台是按每次请求识别的，所以接 GitLab 也照样带 `-we`；要在配置里精确控制列表时，写 `webhookConfig.enable: true` 与 `supportedPlatforms`，不带 `-we` 同样进入守护模式。

## 请求处理的顺序

顺序决定了你看到哪个错误码，前一步失败就不会走到后一步：

| 步 | 检查 | 不通过时 |
|---|---|---|
| 0 | `GET`/`HEAD` 命中 `healthPath`（默认 `/healthz`，写 `false` 关闭） | 直接返回存活信息，不校验签名 |
| — | 正在退出 | `503 { error: '服务正在退出，请重新投递' }` |
| 1 | 路径等于 `webhookConfig.path` | `404 { error: 'Not Found' }` |
| 2 | 方法是 `POST` | `405 { error: 'Method Not Allowed，仅支持 POST' }` |
| 3 | 客户端 IP 在 `ipWhitelist` 内（CIDR 或精确地址；**白名单为空表示放行所有**） | `403` |
| 4 | 令牌桶限流（`maxRequestsPerSecond > 0` 才启用，按 IP 分桶） | `rateLimit.statusCode`（默认 429，未写 `message` 时是"请求过于频繁，请稍后重试"） |
| 5 | 读取请求体，上限 `maxBodyBytes`（默认 1 MiB，可给但必须 ≥1024） | 读取失败 `400`；超限 `413` 并断开连接 |
| 6 | 识别平台 | 识别不出 `401 { error: '无法识别 webhook 平台，缺少平台标识头' }` |
| 7 | 校验签名 / token | 失败 `401`（不回显 secret） |
| 8 | 解析 JSON（顶层必须是对象） | `400 { error: '无效的 JSON 请求体' }` |
| 9 | 事件过滤 | 不触发时 `200 { accepted: false, reason }` |
| 10 | 重复投递（`deduplicate` 未关且平台带了 delivery id） | `200 { accepted: false, reason: '重复投递: <id>' }` |
| 11 | 队列是否还排得下（在途同步数 < `maxQueue`，默认 8） | `503 { error: '同步队列已满（N/M），请稍后重新投递' }` |
| 12 | 受理 | `202 { accepted: true }`，随后异步执行同步 |

内部异常统一 `500 { error: '内部错误' }`，且不会让进程崩溃（处理器外层有兜底）。

存活探针不需要密钥，返回的是运维真正要问的那几件事：`status`（退出中为 `shutting-down` 并配 `503`）、`running`（在途同步数）、`maxQueue`、`uptimeSec`、`counts`（accepted / ignored / rejected / synced / failed 累计）、`lastDelivery`（最后一次投递的时间、决定与分支）、`dedupe`（记住的 delivery id 数）。

客户端 IP 默认只取 socket 地址：任何调用方都能往 `x-forwarded-for` 里填一个白名单地址，从而绕过 `ipWhitelist` 与按 IP 的限流。确认自己在可信反代之后时，把 `trustProxy` 设为 `true`，此时才取 `x-forwarded-for` 的首跳，并剥掉 `::ffff:` 前缀。

## 投递记录、去重与队列

- `deliveryLog`（`--webhook-log`）是 JSONL 审计：每次应答与每次同步的结局各写一行，字段为 `at`、`decision`、`status`、`platform`、`event`、`branch`、`deliveryId`、`reason`、`durationMs`、`ip`。**payload 一律不落盘**——推送事件里带着提交说明、作者邮箱和偶尔的密钥
- 审计行按字段做脱敏（URL 凭据、`token=`、`Bearer …`，外加 webhook secret 与 `logConfig.redact`），颜色码也一并去掉
- 写审计失败只会在控制台警告一句，平台照样拿到应答：磁盘抖动不该变成一次同步风暴
- `deduplicate`（默认开）按平台的 delivery id 去重（`x-github-delivery`、`x-gitea-delivery`、`x-request-id`）。202 是先应答、后同步，所以超时重发是正常现象；已处理过的 id 第二次只回 `重复投递`
- 记住的 id 默认 512 个（`seenHistory`），写在 `<deliveryLog>.seen.json`（可用 `seenStateFile` 指定），重启后仍然有效；这个文件坏了就当没记住任何 id，不会拒绝启动
- 同步会串在仓库锁上，`maxQueue`（默认 8，`--webhook-queue`，范围 1-1000）决定最多让几个投递排队。超出就回 503 请平台稍后重投，而不是让投递方拿着一个永远不会变成同步的 202

`sync-upstream doctor` 会读这些产物：锁持有者、投递审计的尾部、状态文件是否可解析，见 [CI 与自动化](/guide/automation)。

## 平台识别

按请求头判断，顺序如下：

| 头 | 平台 |
|---|---|
| `x-github-event` | `github` |
| `x-gitea-event` | `gitea` |
| `x-gitlab-event` 或 `x-gitlab-token` | `gitlab` |
| `x-event-key` | `bitbucket` |

没有任何标识头时：`supportedPlatforms` 恰好只有一个平台 → 按该平台处理；否则 `401 { error: '无法识别 webhook 平台，缺少平台标识头' }`。`-we` 把四个平台都写进列表，所以用 `-we` 时这条回落路径是走不到的——投递必须带平台头。

## 签名方案

| 平台 | 依据 | 规则 |
|---|---|---|
| GitHub / Gitea | `x-hub-signature-256` | 必须是 `sha256=<hmac(secret, rawBody)>`，十六进制小写比较 |
| Gitea（可选） | `x-hub-signature` | 旧版 `sha1=`，仅在调用方显式打开 `allowLegacySha1` 时才接受；守护模式不开启 |
| GitLab | `x-gitlab-token` | 与 secret 逐字节比较（token 而非 HMAC） |
| Bitbucket | `x-hub-signature` | 要求 `sha256=` 前缀，同 GitHub 算法 |

所有比较都走恒定时间算法，长度不同直接判失败。**`secret` 为空时宁可不服务，也不接受未鉴权投递**：`webhookConfig.enable: true` 而 secret 为空会在校验阶段就被拒绝（`启用 webhook 时 webhookConfig.secret 不能为空`，退出码 2）；以库方式绕过配置校验起服务时，任何请求都是 `401`，原因为 `未配置 webhook secret，无法校验签名`。失败原因里永远不会出现 secret。

## 事件过滤

三层粗筛 + 细筛，全部通过才触发：

1. `delivery.branch` 必须等于 `triggerBranch`，否则 `非触发分支: xxx`
2. `delivery.event` 必须在 `allowedEvents` 中，否则 `事件不在允许列表: xxx`
3. 该事件若配置了 `eventFilterConfig.rules`，则**必须至少命中一条**；一条都没命中返回 `事件 push 未命中任何过滤规则`

分支名已去掉 `refs/heads/`、`refs/tags/` 前缀，但保留中间的斜杠（`feature/foo` 不会被截断）。各平台事件的取值来源：

| 平台 | event 来源 | branch 来源 |
|---|---|---|
| GitHub / Gitea | `x-github-event` / `x-gitea-event`，缺失时按 payload 形状推断（有 `pull_request` → `pull_request`；`ref` 以 `refs/` 开头 → `push`） | `push` 用 `ref`；`pull_request` 用 `pull_request.head.ref` |
| GitLab | `object_kind`，其次 `x-gitlab-event` | `push` 用 `ref`；`merge_request` 用 `object_attributes.source_branch` |
| Bitbucket | `x-event-key`，其次按 `push` / `pullrequest` 推断 | `push.changes[0].new.name`；`pullrequest.source.branch.name` |

规则里的 `conditions` 全部为"与"关系（所有条件都满足才算命中一条规则）。字段用点分路径从 payload 取值（如 `refs.heads.name`），只做属性遍历、不执行任何代码，路径不存在即为 `undefined`。操作符：`eq` / `ne` / `gt` / `lt`（仅数值）/ `contains`（字符串或数组）/ `regex`。正则非法时不会抛异常，而是以固定原因 `过滤规则正则无效` 拒绝该事件。

## 本地验证

```bash
# 存活探针：不需要密钥，能看到在途同步数与累计决定
curl -s localhost:3000/healthz | jq

# 未签名 → 401
curl -sX POST localhost:3000/webhook -H 'content-type: application/json' -d '{"ref":"refs/heads/main"}'

# 带 GitHub 风格签名 → 202
body='{"ref":"refs/heads/main"}'
sig="sha256=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$SYNC_WEBHOOK_SECRET" -hex | awk '{print $NF}')"
curl -sX POST localhost:3000/webhook -H "x-github-event: push" -H "x-hub-signature-256: $sig" -d "$body"

# GitLab 风格（token 而非 HMAC）→ 202
curl -sX POST localhost:3000/webhook -H "x-gitlab-event: Push Hook" -H "x-gitlab-token: $SYNC_WEBHOOK_SECRET" \
  -H 'content-type: application/json' -d '{"ref":"refs/heads/main","object_kind":"push"}'
```

`port: 0` 会让系统随机分配端口，适合本地多次启动；横幅与探针里的端口是实际绑定值。同一目录里再启一次会撞仓库锁（退出码 5），见 [同一个仓库同时只能跑一次](/guide/sync-basics#同一个仓库同时只能跑一次)。如果你要在自己的程序里接管请求对象，请参考 [API 参考的 Webhook 小节](/reference/api#webhook-api)。

## 相关页面

- 字段：[配置参考 webhookConfig](/reference/configuration#webhookconfig)、参数：[CLI 参考](/reference/cli)
- 排错：[常见问题 · Webhook](/faq#webhook)
- 退出码与日志：[CI 与自动化](/guide/automation)、[日志落盘与滚动](/guide/automation#日志落盘与滚动)
- 只读排查：`sync-upstream doctor`、`sync-upstream status`、`sync-upstream history`
