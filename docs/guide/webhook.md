# Webhook 守护模式

`--webhook-enable` 让工具常驻为一个 HTTP 服务：收到推送事件 → 校验通过 → 立刻应答 → 后台跑一次同步。它是普通流水线外加的一层薄壳，同步逻辑完全复用。

## 启动

```bash
sync-upstream -we --webhook-secret "$SYNC_WEBHOOK_SECRET" --webhook-port 3000
```

```
✔ Webhook 服务器已启动，端口: 3000，路径: /webhook
```

守护模式下的每次同步都会强制 `nonInteractive: true`（所以 `prompt-user` 冲突策略自动变成保留本地），`autoPush` 仍按配置生效；同步失败只记日志，服务不会退出，`Ctrl+C` / `SIGTERM` 会先关连接再退出。

## 配置

```json
{
  "webhookConfig": {
    "enable": true,
    "port": 3000,
    "path": "/webhook",
    "secret": "从部署环境变量注入，不要提交进仓库",
    "allowedEvents": ["push"],
    "triggerBranch": "main",
    "supportedPlatforms": ["github", "gitlab"],
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

注意：工具**不读任何环境变量**，`--webhook-secret "$SYNC_WEBHOOK_SECRET"` 是由 shell 展开后代入的，配置文件里也一样只能写字面值或由 CI 生成文件。

## 请求处理的顺序

顺序决定了你看到哪个错误码，前一步失败就不会走到后一步：

| 步 | 检查 | 不通过时 |
|---|---|---|
| 1 | 路径等于 `webhookConfig.path` | `404 { error: 'Not Found' }` |
| 2 | 方法是 `POST` | `405` |
| 3 | 客户端 IP 在 `ipWhitelist` 内（CIDR 或精确地址；**白名单为空表示放行所有**） | `403` |
| 4 | 令牌桶限流（`maxRequestsPerSecond > 0` 才启用，按 IP 分桶） | `rateLimit.statusCode`（默认 429） |
| 5 | 读取请求体，上限 **1 MiB** | 读取失败 `400`；超限 `413` 并断开连接 |
| 6 | 识别平台 | 识别不出 `401` |
| 7 | 校验签名 / token | 失败 `401`（不回显 secret） |
| 8 | 解析 JSON（顶层必须是对象） | `400` |
| 9 | 事件过滤 | 不触发时 `200 { accepted: false, reason }` |
| 10 | 受理 | `202 { accepted: true }`，随后异步执行同步 |

内部异常统一 `500`，且不会让进程崩溃（`handle` 外层有兜底）。

客户端 IP 取 `x-forwarded-for` 的**首跳**，没有该头时取 socket 地址，并剥掉 `::ffff:` 前缀。直接把服务暴露在公网时，任何人都能伪造 `x-forwarded-for` 绕过基于它的白名单——请放在可信反代之后，或改用来源 IP 段限制。

## 平台识别

按请求头判断，顺序如下：

| 头 | 平台 |
|---|---|
| `x-github-event` | `github` |
| `x-gitea-event` | `gitea` |
| `x-gitlab-event` 或 `x-gitlab-token` | `gitlab` |
| `x-event-key` | `bitbucket` |

没有任何标识头时：`supportedPlatforms` 恰好只有一个平台 → 按该平台处理；否则 `401`。

## 签名方案

| 平台 | 依据 | 规则 |
|---|---|---|
| GitHub / Gitea | `x-hub-signature-256` | 必须是 `sha256=<hmac(secret, rawBody)>`，十六进制小写比较 |
| Gitea（可选） | `x-hub-signature` | 旧版 `sha1=`，仅在调用方显式打开 `allowLegacySha1` 时才接受；守护模式不开启 |
| GitLab | `x-gitlab-token` | 与 secret 逐字节比较（token 而非 HMAC） |
| Bitbucket | `x-hub-signature` | 要求 `sha256=` 前缀，同 GitHub 算法 |

所有比较都走恒定时间算法，长度不同直接判失败。**`secret` 为空时任何请求都是 `401`**，这是有意的：宁可不服务，也不接受未鉴权投递。

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
# 未签名 → 401
curl -sX POST localhost:3000/webhook -H 'content-type: application/json' -d '{"ref":"refs/heads/main"}'

# 带 GitHub 风格签名 → 202
body='{"ref":"refs/heads/main"}'
sig="sha256=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$SYNC_WEBHOOK_SECRET" -hex | awk '{print $NF}')"
curl -sX POST localhost:3000/webhook -H "x-github-event: push" -H "x-hub-signature-256: $sig" -d "$body"
```

`port: 0` 会让系统随机分配端口，适合本地多次启动；如果你要在自己的程序里接管请求对象，请参考 [API 参考的 Webhook 小节](/reference/api#webhook-api)。

## 相关页面

- 字段：[配置参考 webhookConfig](/reference/configuration#webhookconfig)
- 排错：[常见问题 · Webhook](/faq#webhook)
- 退出码与日志：[CI 与自动化](/guide/automation)
