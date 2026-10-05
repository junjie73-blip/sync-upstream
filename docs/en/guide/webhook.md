# Webhook daemon

`--webhook-enable` turns the tool into a long-running HTTP server: a push event arrives → it is validated → the response goes out immediately → a sync runs in the background. It is a thin shell around the plain pipeline, and the sync logic is reused entirely.

## Starting the daemon

```bash
sync-upstream -we --webhook-secret "$SYNC_WEBHOOK_SECRET" --webhook-port 3000
```

```
✔ Webhook 服务器已启动，端口: 3000，路径: /webhook
```

This startup line is printed by the tool and means: "Webhook server started, port: 3000, path: /webhook".

Every sync started by the daemon forces `nonInteractive: true` (so the `prompt-user` conflict strategy automatically becomes keep local), while `autoPush` still follows the configuration. A failed sync is only logged — the service does not exit; `Ctrl+C` / `SIGTERM` close the connections before exiting.

## Configuration

```json
{
  "webhookConfig": {
    "enable": true,
    "port": 3000,
    "path": "/webhook",
    "secret": "inject from your deployment environment; never commit it to the repository",
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

Note: the tool **reads no environment variables at all**. `--webhook-secret "$SYNC_WEBHOOK_SECRET"` is expanded by the shell before the tool sees it; in a configuration file you can only write a literal value, or generate the file in CI.

## Request handling order

This order decides which error code you see; a failing step never reaches the next one:

| Step | Check | On failure |
|---|---|---|
| 1 | The path equals `webhookConfig.path` | `404 { error: 'Not Found' }` |
| 2 | The method is `POST` | `405` |
| 3 | The client IP is inside `ipWhitelist` (CIDR or exact address; **an empty allowlist allows everything**) | `403` |
| 4 | Token-bucket rate limiting (enabled only when `maxRequestsPerSecond > 0`, one bucket per IP) | `rateLimit.statusCode` (429 by default) |
| 5 | Read the request body, capped at **1 MiB** | `400` when reading fails; `413` plus a dropped connection when over the limit |
| 6 | Detect the platform | `401` when it cannot be detected |
| 7 | Verify the signature / token | `401` on failure (the secret is never echoed back) |
| 8 | Parse the JSON (the top level must be an object) | `400` |
| 9 | Event filtering | `200 { accepted: false, reason }` when nothing triggers |
| 10 | Accept | `202 { accepted: true }`, then the sync runs asynchronously |

Internal errors always map to `500` and never crash the process (`handle` has an outer safety net).

The client IP is taken from the **first hop** of `x-forwarded-for`; with no such header the socket address is used, and the `::ffff:` prefix is stripped. If you expose the service directly to the public internet, anyone can forge `x-forwarded-for` and bypass an allowlist built on it — put it behind a trusted reverse proxy, or restrict by source IP range instead.

## Platform detection

Decided from request headers, in this order:

| Header | Platform |
|---|---|
| `x-github-event` | `github` |
| `x-gitea-event` | `gitea` |
| `x-gitlab-event` or `x-gitlab-token` | `gitlab` |
| `x-event-key` | `bitbucket` |

With no identifying header at all: if `supportedPlatforms` contains exactly one platform, the request is handled as that platform; otherwise `401`.

## Signature schemes

| Platform | Based on | Rule |
|---|---|---|
| GitHub / Gitea | `x-hub-signature-256` | Must be `sha256=<hmac(secret, rawBody)>`, compared as lowercase hex |
| Gitea (optional) | `x-hub-signature` | Legacy `sha1=`, accepted only when the caller explicitly enables `allowLegacySha1`; the daemon never enables it |
| GitLab | `x-gitlab-token` | Byte-for-byte comparison with the secret (a token, not HMAC) |
| Bitbucket | `x-hub-signature` | Requires a `sha256=` prefix, same algorithm as GitHub |

All comparisons are constant-time, and a length mismatch fails immediately. **When `secret` is empty every request gets `401`** — that is intentional: better to serve nothing than to accept an unauthenticated delivery.

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
# unsigned -> 401
curl -sX POST localhost:3000/webhook -H 'content-type: application/json' -d '{"ref":"refs/heads/main"}'

# with a GitHub-style signature -> 202
body='{"ref":"refs/heads/main"}'
sig="sha256=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$SYNC_WEBHOOK_SECRET" -hex | awk '{print $NF}')"
curl -sX POST localhost:3000/webhook -H "x-github-event: push" -H "x-hub-signature-256: $sig" -d "$body"
```

With `port: 0` the system assigns a port, which is handy for running several local instances. If you want to hand your own request objects to the server, see [the Webhook section of the API reference](/en/reference/api#webhook-api).

## Related pages

- Fields: [webhookConfig in the configuration reference](/en/reference/configuration#webhookconfig)
- Troubleshooting: [FAQ · Webhook](/en/faq#webhook)
- Exit codes and logging: [CI and automation](/en/guide/automation)
