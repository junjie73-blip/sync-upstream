# Webhook daemon

`--webhook-enable` turns the tool into a long-running HTTP server: a push event arrives → it passes validation → the response goes out immediately → a sync runs in the background. It is a thin shell added on top of the normal pipeline, and the sync logic is reused entirely.

## Starting the daemon

```bash
sync-upstream -we --webhook-secret "$SYNC_WEBHOOK_SECRET" --webhook-port 3000
sync-upstream -we --webhook-host 0.0.0.0 --webhook-log var/log/deliveries.jsonl
sync-upstream -we --webhook-port 0 --webhook-queue 16        # random port, queue widened to 16
```

```text
Webhook 服务已启动: http://127.0.0.1:3000/webhook（Ctrl+C 退出）
投递决定写入 /abs/path/var/log/deliveries.jsonl
```

The first line means "Webhook server started: http://127.0.0.1:3000/webhook (Ctrl+C to exit)"; the second means "Delivery decisions are written to /abs/path/var/log/deliveries.jsonl".

- **It binds to `127.0.0.1` only by default** (`host`, `--webhook-host`): a sync daemon that listens on every interface by default is exactly how an intranet repository ends up reachable from the whole network. On the public internet or in a container, write `"0.0.0.0"` explicitly.
- `port: 0` (`--webhook-port 0`) lets the system assign a port, and the banner prints the address and port **actually bound**.
- Give `tlsCert` + `tlsKey` (two PEM paths, always as a pair) and it serves HTTPS; the protocol in the banner becomes `https://` accordingly.
- With `logConfig.file` set, one extra line is printed: `日志同时写入 …` ("logs are also written to …"). Delivery decisions and the outcome of every in-flight sync then survive in that file.
- With no `deliveryLog`, you get a warning: `未设置 webhookConfig.deliveryLog：投递决定只出现在控制台，进程退出后无从回看` ("webhookConfig.deliveryLog is not set: delivery decisions only appear on the console and cannot be reviewed after the process exits").

Every sync started by the daemon forces `nonInteractive: true` (so the `prompt-user` conflict strategy automatically becomes keep local), while `autoPush` still follows the configuration. A failed sync is only logged — the service does not exit. Network-class failures are retried according to `webhookConfig.retryConfig` (the top-level `retryConfig` when it is not given), and a notification is sent only once the retries are exhausted.

`Ctrl+C` / `SIGTERM` stop accepting requests first, then wait for the in-flight syncs to finish: during that window new requests get `503 服务正在退出，请重新投递` ("the service is shutting down, please redeliver"), and the log prints `Webhook 监听已关闭，等待在途同步完成…` ("webhook listener closed, waiting for in-flight syncs to finish") followed by `Webhook 服务器已停止` ("webhook server stopped"). Process-level uncaught exceptions and rejected promises are logged rather than fatal — a daemon that has stopped answering is harder to notice than a failed delivery.

## Configuration

```json
{
  "webhookConfig": {
    "enable": true,
    "host": "127.0.0.1",
    "port": 3000,
    "path": "/webhook",
    "secret": "inject from your deployment environment; never commit it to the repository",
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

Note: the tool **does not change its behaviour because it read an environment variable**; the value in `--webhook-secret "$SYNC_WEBHOOK_SECRET"` is expanded by the shell before it is passed in (the only exceptions are `SYNC_UPSTREAM_LANG`, `LC_ALL`, `LANG`, `LANGUAGE` and `GITHUB_STEP_SUMMARY`, see [CI and automation](/en/guide/automation)). A configuration file can only hold literal values as well, or be generated in CI.

`-we` writes `supportedPlatforms` as all four of `github`, `gitlab`, `bitbucket`, `gitea` (the array is replaced wholesale, so the platform list in your configuration file is overwritten by it). The platform is identified per request, so serving GitLab still works with `-we`; when you want exact control of the list in the configuration, write `webhookConfig.enable: true` plus `supportedPlatforms` and leave out `-we` — you still enter daemon mode.

## Request handling order

This order decides which error code you see; a step that fails never reaches the next one:

| Step | Check | On failure |
|---|---|---|
| 0 | A `GET`/`HEAD` hits `healthPath` (`/healthz` by default; set it to `false` to disable) | liveness information is returned directly, with no signature check |
| — | The daemon is shutting down | `503 { error: '服务正在退出，请重新投递' }` ("the service is shutting down, please redeliver") |
| 1 | The path equals `webhookConfig.path` | `404 { error: 'Not Found' }` |
| 2 | The method is `POST` | `405 { error: 'Method Not Allowed，仅支持 POST' }` ("method not allowed, POST only") |
| 3 | The client IP is inside `ipWhitelist` (CIDR or exact address; **an empty allowlist allows everything**) | `403` |
| 4 | Token-bucket rate limiting (enabled only when `maxRequestsPerSecond > 0`, one bucket per IP) | `rateLimit.statusCode` (429 by default; with no `message` the text is `请求过于频繁，请稍后重试` — "too many requests, please retry later") |
| 5 | Read the request body, capped at `maxBodyBytes` (1 MiB by default; it may be set but must be ≥ 1024) | `400` when reading fails; `413` plus a dropped connection when over the limit |
| 6 | Detect the platform | `401 { error: '无法识别 webhook 平台，缺少平台标识头' }` when it cannot be detected ("cannot identify the webhook platform, the platform-identifying header is missing") |
| 7 | Verify the signature / token | `401` on failure (the secret is never echoed back) |
| 8 | Parse the JSON (the top level must be an object) | `400 { error: '无效的 JSON 请求体' }` ("invalid JSON request body") |
| 9 | Event filtering | `200 { accepted: false, reason }` when nothing triggers |
| 10 | Duplicate delivery (`deduplicate` not switched off and the platform sent a delivery id) | `200 { accepted: false, reason: '重复投递: <id>' }` ("duplicate delivery: `<id>`") |
| 11 | Whether the queue still has room (in-flight sync count < `maxQueue`, 8 by default) | `503 { error: '同步队列已满（N/M），请稍后重新投递' }` ("the sync queue is full (N/M), please redeliver later") |
| 12 | Accept | `202 { accepted: true }`, then the sync runs asynchronously |

An internal exception always maps to `500 { error: '内部错误' }` ("internal error") and never crashes the process (there is an outer safety net around the handler).

The liveness probe needs no key and returns the few things an operator actually asks: `status` (`shutting-down` while exiting, together with `503`), `running` (the in-flight sync count), `maxQueue`, `uptimeSec`, `counts` (cumulative accepted / ignored / rejected / synced / failed), `lastDelivery` (the time, decision and branch of the last delivery), `dedupe` (how many delivery ids are remembered).

By default the client IP comes from the socket address alone: any caller can put an allowlisted address into `x-forwarded-for` and thereby bypass both `ipWhitelist` and the per-IP rate limit. When you really are behind a trusted reverse proxy, set `trustProxy` to `true`; only then is the first hop of `x-forwarded-for` used, and the `::ffff:` prefix is stripped from it.

## Delivery records, dedupe and the queue

- `deliveryLog` (`--webhook-log`) is a JSONL audit trail: one line per response and one line per sync outcome, with the fields `at`, `decision`, `status`, `platform`, `event`, `branch`, `deliveryId`, `reason`, `durationMs`, `ip`. **Payloads are never written to disk** — a push event carries commit messages, author email addresses and occasionally a secret.
- Audit lines are redacted field by field (URL credentials, `token=`, `Bearer …`, plus the webhook secret and `logConfig.redact`), and colour codes are stripped as well.
- A failed audit write only prints a warning on the console; the platform still gets its response — a disk hiccup should not turn into a sync storm.
- `deduplicate` (on by default) dedupes on the platform's delivery id (`x-github-delivery`, `x-gitea-delivery`, `x-request-id`). A 202 is answered before the sync runs, so timeouts and redeliveries are normal; an id that was already handled gets only `重复投递` ("duplicate delivery") the second time.
- 512 ids are remembered by default (`seenHistory`), written to `<deliveryLog>.seen.json` (override it with `seenStateFile`), and they survive a restart; a damaged file is treated as "no id remembered" and never blocks startup.
- Syncs are chained onto the repository lock, and `maxQueue` (default 8, `--webhook-queue`, range 1-1000) decides how many deliveries may queue at all. Once it is full you get a 503 asking the platform to redeliver later, instead of the deliverer holding a 202 that never becomes a sync.

`sync-upstream doctor` reads these artefacts: the lock holder, the tail of the delivery audit, and whether the state file parses — see [CI and automation](/en/guide/automation).

## Platform detection

Decided from the request headers, in this order:

| Header | Platform |
|---|---|
| `x-github-event` | `github` |
| `x-gitea-event` | `gitea` |
| `x-gitlab-event` or `x-gitlab-token` | `gitlab` |
| `x-event-key` | `bitbucket` |

With no identifying header at all: if `supportedPlatforms` contains exactly one platform, the request is handled as that platform; otherwise `401 { error: '无法识别 webhook 平台，缺少平台标识头' }` ("cannot identify the webhook platform, the platform-identifying header is missing"). `-we` writes all four platforms into the list, so with `-we` this fallback path is unreachable — a delivery has to carry a platform header.

## Signature schemes

| Platform | Based on | Rule |
|---|---|---|
| GitHub / Gitea | `x-hub-signature-256` | Must be `sha256=<hmac(secret, rawBody)>`, compared as lowercase hex |
| Gitea (optional) | `x-hub-signature` | Legacy `sha1=`, accepted only when the caller explicitly enables `allowLegacySha1`; the daemon never enables it |
| GitLab | `x-gitlab-token` | Byte-for-byte comparison with the secret (a token, not HMAC) |
| Bitbucket | `x-hub-signature` | Requires a `sha256=` prefix, same algorithm as GitHub |

All comparisons run in constant time, and a length mismatch fails immediately. **When `secret` is empty the daemon prefers to serve nothing over accepting an unauthenticated delivery**: with `webhookConfig.enable: true` and an empty secret, the run is rejected already during validation (`启用 webhook 时 webhookConfig.secret 不能为空` — "webhookConfig.secret must not be empty when webhook is enabled", exit code 2); if you start the server as a library and bypass configuration validation, every request gets `401` with the reason `未配置 webhook secret，无法校验签名` ("no webhook secret configured, signatures cannot be verified"). The failure reason never contains the secret.

## Event filtering

Three coarse screens plus a fine filter; all of them must pass for a sync to be triggered:

1. `delivery.branch` must equal `triggerBranch`, otherwise `非触发分支: xxx` ("non-triggering branch: `<branch>`")
2. `delivery.event` must be in `allowedEvents`, otherwise `事件不在允许列表: xxx` ("event not in the allowed list: `<event>`")
3. If `eventFilterConfig.rules` are configured for that event, **at least one rule must match**; with no match the response reason is `事件 push 未命中任何过滤规则` ("event push matched no filter rule")

Branch names already have the `refs/heads/` and `refs/tags/` prefixes stripped, but inner slashes are preserved (`feature/foo` is not truncated). Where each platform's values come from:

| Platform | Source of `event` | Source of `branch` |
|---|---|---|
| GitHub / Gitea | `x-github-event` / `x-gitea-event`; when missing, inferred from the payload shape (a `pull_request` key → `pull_request`; a `ref` starting with `refs/` → `push`) | `push` uses `ref`; `pull_request` uses `pull_request.head.ref` |
| GitLab | `object_kind`, then `x-gitlab-event` | `push` uses `ref`; `merge_request` uses `object_attributes.source_branch` |
| Bitbucket | `x-event-key`, then inferred from `push` / `pullrequest` | `push.changes[0].new.name`; `pullrequest.source.branch.name` |

All `conditions` inside a rule are ANDed together (a rule matches only when every condition holds). Fields are read from the payload by dotted paths (for example `refs.heads.name`) through plain property traversal — no code is executed, and a missing path yields `undefined`. Operators: `eq` / `ne` / `gt` / `lt` (numbers only) / `contains` (string or array) / `regex`. An invalid regular expression never throws; the event is rejected with the fixed reason `过滤规则正则无效` ("filter rule regex is invalid").

## Testing locally

```bash
# liveness probe: no key needed, shows the in-flight sync count and the cumulative decisions
curl -s localhost:3000/healthz | jq

# unsigned -> 401
curl -sX POST localhost:3000/webhook -H 'content-type: application/json' -d '{"ref":"refs/heads/main"}'

# with a GitHub-style signature -> 202
body='{"ref":"refs/heads/main"}'
sig="sha256=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$SYNC_WEBHOOK_SECRET" -hex | awk '{print $NF}')"
curl -sX POST localhost:3000/webhook -H "x-github-event: push" -H "x-hub-signature-256: $sig" -d "$body"

# GitLab style (a token, not HMAC) -> 202
curl -sX POST localhost:3000/webhook -H "x-gitlab-event: Push Hook" -H "x-gitlab-token: $SYNC_WEBHOOK_SECRET" \
  -H 'content-type: application/json' -d '{"ref":"refs/heads/main","object_kind":"push"}'
```

With `port: 0` the system assigns a port at random, which is handy for starting several local instances; the port in the banner and in the probe is the value actually bound. Starting another run in the same directory collides with the repository lock (exit code 5), see [Everyday sync](/en/guide/sync-basics). If you want to hand your own request objects to the server, see [the Webhook section of the API reference](/en/reference/api#webhook-api).

## Related pages

- Fields: [webhookConfig in the configuration reference](/en/reference/configuration#webhookconfig); flags: [CLI reference](/en/reference/cli)
- Troubleshooting: [FAQ · Webhook](/en/faq#webhook)
- Exit codes and logging: [CI and automation](/en/guide/automation), [logging on disk and rotation](/en/guide/automation#logging)
- Read-only triage: `sync-upstream doctor`, `sync-upstream status`, `sync-upstream history`
