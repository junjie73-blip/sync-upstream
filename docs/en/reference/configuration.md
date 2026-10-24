# Configuration Reference

This page lists the canonical fields of `SyncConfig` one by one. The config file, the command line, and the programmatic API all use the **same key names**; historical aliases are covered in [the aliases section of the configuration guide](/en/guide/configuration#aliases-and-removed-keys).

The types can be imported straight from the package:

```ts
import type { GrayReleaseConfig, SyncConfig, WebhookConfig } from 'sync-upstream'
```

## Top-level fields

| Field | Type | Default | Command line | Description |
|---|---|---|---|---|
| `upstreamRepo` | `string` | `''` (required) | `-r, --repo` | upstream repository URL |
| `upstreamBranch` | `string` | `'main'` | `-b, --branch` | the upstream ref to sync: a branch, a tag or a commit all work; use the `refs/heads/…` or `refs/tags/…` prefix when you need to be explicit |
| `companyBranch` | `string` | `'main'` | `-c, --company-branch` | target branch (must already exist locally / on `origin`) |
| `syncDirs` | `string[]` | `[]` (required, non-empty) | `-d, --dirs` | sync scope, paths relative to the repository root; matches directories as well as files with the same name |
| `upstreams` | `UpstreamSource[]` | unset | repeated `-r` / `-b` | multi-upstream fan-in, see [multiple upstream sources](#multiple-upstream-sources) |
| `commitMessage` | `string` | `'Sync upstream changes to specified directories'` | `-m, --message` | commit message |
| `autoPush` | `boolean` | `false` | `-p, --push` | push after committing; forced off with a warning when `dryRun` is true, and switched off the same way when `prConfig` is on |
| `forceOverwrite` | `boolean` | `true` | `-f, --force` / `--incremental` | `true` applies the whole plan; `false` goes incremental based on `.sync-state.json` |
| `deletePolicy` | `'mirror'` / `'keep'` / `'ask'` | `'mirror'` | `--delete-policy`, `--delete` / `--no-delete` | what happens to files upstream deleted that the target branch still carries, see [deletion and renames](#deletion-and-renames) |
| `renameDetection` | `boolean` | `true` | `--renames` / `--no-renames` | whether an upstream rename is folded into a single move |
| `renameThreshold` | `number` | `60` | `--rename-threshold` | similarity percentage (integer 1–100); below it a delete/add pair counts as two separate files |
| `verbose` | `boolean` | `false` | `-V, --verbose` | raises the log level and prints the full change list |
| `silent` | `boolean` | `false` | `-s, --silent` | print errors only |
| `dryRun` | `boolean` | `false` | `-n, --dry-run` | dry run, equivalent to `previewOnly` |
| `previewOnly` | `boolean` | `false` | `-P, --preview-only` | print the plan only |
| `nonInteractive` | `boolean` | `false` | `-y, --non-interactive` | ask nothing; `prompt-user` degrades to `keep-target` |
| `concurrencyLimit` | `number` | `10` | `--concurrency` | concurrency of the per-path retry after a batch apply failure (integer ≥ 1) |
| `lockWaitMs` | `number` | `0` | `--lock-wait` | milliseconds to wait for another sync to release the repository lock (integer ≥ 0); `0` means it errors out immediately when the lock is held |
| `includeFileTypes` | `string[]` | `[]` | `--include-types` | extension allowlist; empty means no filtering; a spelling without the dot gets the dot added and is lowercased |
| `ignorePatterns` | `string[]` | `[]` | `--ignore` | appended ignore rules (gitignore syntax) |
| `retryConfig` | `RetryConfig` | see below | `--retry-*` | retries for network-class operations such as fetch |
| `conflictResolutionConfig` | `ConflictResolutionConfig` | see below | `--conflict-strategy` | conflict handling |
| `fetchConfig` | `FetchConfig` | see below | `--fetch-filter` / `--fetch-depth` / `--fetch-tags` / `--lfs` | how much content to ask upstream for, and what gets written for Git LFS files |
| `logConfig` | `LogConfig?` | unset (console output only) | `--log-*` | logging to a file and rotation |
| `authConfig` | `AuthConfig?` | unset | `--auth-*` | credentials for accessing upstream |
| `branchStrategyConfig` | `BranchStrategyConfig` | `enable: false`, the rest below | — | sync on a derived branch |
| `grayReleaseConfig` | `GrayReleaseConfig?` | unset | `-gr`, etc. | gray release |
| `webhookConfig` | `WebhookConfig?` | unset | `-we`, etc. | Webhook daemon mode |
| `notifyConfig` | `NotifyConfig` | `enable: false`, `channels: []` | `--notify*` / `--no-notify` | announcements after the run finishes |
| `prConfig` | `PrConfig?` | unset | `--pr*` | PR mode: the changes go to an auto-generated branch and the target branch stays untouched |
| `fullRelease` | `boolean` | `false` | `-fr, --full-release` | release the remaining gray-release files |
| `rollback` | `boolean` | `false` | `-ro, --rollback` | roll back the gray release on record |

Boolean fields such as `verbose`, `silent`, and `dryRun` are only written at the command-line layer when the flag is present, so a `true` in the config file is not reset to `false` by a command line that omits the flag.

Some switches exist only on the command line and have no key in the configuration file: `-uo, --undo` (undo the last sync recorded in the state file), `--lang` (the language of this run's output), `--json`, `--debug`, `--fetch`, `--limit`, and the actions `status` / `why` / `doctor` / `history` / `init` / `completion`. The language can also be selected through the `SYNC_UPSTREAM_LANG` environment variable (details in the [CLI reference](/en/reference/cli)).

## Accepted shapes for `upstreamRepo`

| Form | Example |
|---|---|
| HTTPS / HTTP | `https://github.com/org/repo.git` |
| SSH URL | `ssh://git@github.com/org/repo.git` |
| git / file protocols | `git://host/repo.git`, `file:///srv/repo` |
| scp-style | `git@github.com:org/repo.git` (normalised internally to `ssh://`) |
| local path | `/srv/repo`, `../vendor/repo`, `J:\vendor\repo` |

Local paths are handy for testing and offline scenarios: upstream can be another repository on your own disk.

`upstreamBranch` is not limited to branches: tag names (`v1.8.0`) and commit IDs work just as well, and then the sync mirrors the content of that version rather than the current tip of a branch. Fetching by commit ID needs the server to allow it (`uploadpack.allowAnySHA1InWant`).

## Multiple upstream sources

Use this section when one target branch follows several upstreams at the same time. Each entry describes exactly one source, and all four fields may be omitted: an omitted field inherits the top-level `upstreamRepo` / `upstreamBranch` / `syncDirs` / `commitMessage`.

```json
{
  "upstreamRepo": "https://github.com/org/base.git",
  "upstreamBranch": "main",
  "syncDirs": ["src/config"],
  "upstreams": [
    { "branch": "dev" },
    { "repo": "https://github.com/org/ui-kit.git", "branch": "release", "dirs": ["src/components"], "message": "Sync ui-kit release" }
  ]
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `repo` | `string` | the top-level `upstreamRepo` | this source's repository URL; required when the top-level URL is empty |
| `branch` | `string` | the top-level `upstreamBranch` | this source's branch / tag / commit |
| `dirs` | `string[]` | the top-level `syncDirs` | the sync directories this source owns; a non-empty array |
| `message` | `string` | the top-level `commitMessage` | the message of this source's commit |

Rules and consequences:

- Once you write `upstreams`, the run processes only that list and **does not additionally process the top-level entry**. To follow the top-level source as well, write it as the first item of the list.
- Each source has its own incremental state file and its own commit; the fetch remotes are separated by **repository** (several refs of one repository share a remote, different repositories each get one): the first is `sync-upstream`, then `sync-upstream-2`, `sync-upstream-3`…
- Overlapping directories are applied in configuration order, so a later source overwrites an earlier one; a source listed twice, and overlapping directories, both produce warnings.
- The incremental state files are written at the repository root, named `.sync-state-<ref>-<8-char hash>.json`. The built-in ignore rules match the single name `.sync-state.json` exactly, so add `.sync-state-*.json` to your `.gitignore` as well.
- Multi-upstream and gray release are mutually exclusive: `-gr` / `-fr` / `-ro` error out directly when there is more than one source, so configure exactly one source when you want a gray release.

On the command line, repeating `-r` (or `-b`) is the shorthand for this section: `-r A -r B` means two sources with every other field inherited from the top level.

## Deletion and renames

| Field | Allowed values / range | Default | Description |
|---|---|---|---|
| `deletePolicy` | `mirror` / `keep` / `ask` | `mirror` | how to treat files upstream deleted but the target branch still has |
| `renameDetection` | boolean | `true` | whether an upstream rename (a path that moved with its content basically unchanged) becomes a single move |
| `renameThreshold` | integer 1–100 | `60` | the similarity floor for rename pairs, i.e. the percentage behind git's `--find-renames` |

The three `deletePolicy` values differ as follows:

| Value | Behaviour |
|---|---|
| `mirror` | follow upstream's deletions, so the paths in sync scope match upstream byte for byte (the behaviour of every previous version) |
| `keep` | keep the local files; every deletion is recorded as a skip and reported |
| `ask` | asks once per run; with `-y`, `--json`, or no terminal to answer in, it behaves as `keep` |

On the command line: `--delete-policy mirror|keep|ask`, plus the shorthands `--delete` (= `mirror`) and `--no-delete` (= `keep`); given explicitly they override the configuration file.

With `renameDetection` `true`, a rename is one move in the plan: the old path is deleted and the new path written, so local edits to that file and its file history both survive; with `false` it is handled as two entries, "delete + add". A delete/add pair below `renameThreshold` is still treated as two separate files.

These three combinations **switch rename detection off automatically** and warn, because renames cannot coexist with them:

- `deletePolicy: 'keep'`: a rename removes the old path too, which contradicts the promise not to delete local files — switch back to `mirror` if you want renames
- `grayReleaseConfig` enabled: a rename can only be applied as a whole, never rolled out per batch, so this run treats it as delete + add
- `fetchConfig.depth` set: the older revisions outside the fetch window cannot be read, so no pair can be formed

## retryConfig

```json
{ "retryConfig": { "maxRetries": 3, "initialDelay": 2000, "backoffFactor": 1.5 } }
```

| Field | Constraint | Meaning |
|---|---|---|
| `maxRetries` | integer ≥ 0 | number of retries beyond the first attempt |
| `initialDelay` | ≥ 0 | milliseconds to wait before the first retry |
| `backoffFactor` | ≥ 1 | the n-th wait is `initialDelay × factor^(n-1)` |

A retry only happens when the error message matches the network-class signatures `网络` (meaning "network"), `network`, `connect`, `resolve host`, `timed out`, `timeout`, `reset`, `closed`, `RPC failed`, `early EOF`, `无法访问` (meaning "cannot access") and `不可达` (meaning "not reachable"), matched case-insensitively; authentication failures and illegal paths rethrow the original error immediately. Once retries are exhausted the error is wrapped as `TimeoutError` (when the message contains `超时`, meaning "timed out") or `NetworkError`.

Matching command-line flags: `--retry-max`, `--retry-delay`, `--retry-backoff` (each overridable independently, without affecting the others).

## fetchConfig

Decides how much content you ask upstream for. The defaults are exactly what previous versions did: fetch everything and issue no extra LFS requests.

```json
{ "fetchConfig": { "filter": "blob", "tags": false, "lfs": "pointer", "depth": 50 } }
```

| Field | Type | Default | Command line | Description |
|---|---|---|---|---|
| `filter` | `none` / `blob` / `tree` | `none` | `--fetch-filter` | partial fetch. `none` transfers every object and is the only mode that can read upstream file content offline; `blob` takes only commits and trees and fetches file content on demand, the cheapest option that "can still compute a plan"; `tree` takes only commits — the smallest transfer, but every file read needs the network, and the wider your sync directories the more likely it is slower than `none` (which produces a warning) |
| `depth` | `number` (optional) | unset | `--fetch-depth` | fetch only the last n commits (integer ≥ 1). **The side effect is that the whole local repository becomes shallow**: other people's `git log` gets shorter too, and history outside the fetch window cannot be read. Omitting this key puts no limit on depth |
| `tags` | `boolean` | `false` | `--fetch-tags` / `--no-fetch-tags` | whether a fetch also brings upstream tags; by default it does not, so an ordinary branch fetch does not drag back upstream's whole tag table |
| `lfs` | `pointer` / `materialize` / `off` | `pointer` | `--lfs` | what gets written into the working tree for files upstream manages with Git LFS. `pointer` writes only the pointer text (right when it evolves alongside the source files, unusable for binary assets); `materialize` writes the pointer, then fetches the real content from upstream and replaces it, which needs `git-lfs` on the machine and a reachable upstream LFS service; `off` does no LFS detection at all |

Combinations worth knowing:

- `depth` and rename detection cannot coexist: setting `depth` switches rename detection off with a warning
- `lfs: 'materialize'` with `filter: 'blob'` or `tree` saves little traffic (fetching real content means pulling the objects back anyway), and warns
- `filter` and `tags` only change how much is fetched; incremental skipping and rename pairing still work under `blob`

Every run reports how many LFS pointers it met and how many real objects it fetched back. Without `git-lfs` on the machine, or when the upstream LFS service is unreachable, you only get a note — the sync itself does not fail.

## conflictResolutionConfig

```json
{
  "conflictResolutionConfig": {
    "defaultStrategy": "prompt-user",
    "autoResolveTypes": [".md"],
    "logResolutions": true
  }
}
```

| Field | Default | Description |
|---|---|---|
| `defaultStrategy` | `prompt-user` | `use-source` / `keep-target` / `auto-merge` / `prompt-user` / `skip` |
| `autoResolveTypes` | `[]` | matching extensions skip the prompt under `prompt-user` and keep the local version directly |
| `logResolutions` | `true` | log each decision (at `debug` level), including path, type, strategy, action, and reason |
| `resolutionLogFile` | unset | each decision is appended to this file as JSONL (a relative path resolves against the repository root); no file is created when nothing conflicted |

Strategy-to-action mapping: `use-source → take-upstream`, `keep-target → keep-local`, `skip → skip`, `auto-merge →` decided by the three-way merge result (it may produce a `write-merged` that still carries conflict markers).

Conflict detection currently yields four types: `content` (content conflict), `delete-modify` (upstream deleted it but the local copy has changes), `untracked-overwrite` (an untracked file has to be overwritten) and `type` (a file and a directory swap places); `add-add`, `symlink` and `unreadable` are reserved values in the type that the current version never produces.

## authConfig

```json
{ "authConfig": { "type": "pat", "username": "git", "token": "..." } }
```

| `type` | Required fields | Transport |
|---|---|---|
| `ssh` | `privateKeyPath` (`passphrase` optional) | subprocess environment `GIT_SSH_COMMAND = ssh -i <key> -o IdentitiesOnly=yes -o BatchMode=yes` |
| `pat` | `token` (username fixed to `git`) | credentials written into the userinfo part of the remote URL |
| `user_pass` | `username` + `password` | same as above |

Key points:

- A passphrase-protected key will not be prompted for its passphrase interactively (under `BatchMode`, git fails outright); the tool tells you to add the key to ssh-agent first.
- Any `user:secret@host` in logs and error messages is replaced with `***`.
- GitHub App and OIDC are not implemented.

## branchStrategyConfig

```json
{
  "branchStrategyConfig": {
    "enable": true,
    "strategy": "feature",
    "baseBranch": "company/main",
    "branchPattern": "feature/sync-{date}",
    "autoSwitchBack": true,
    "autoDeleteMergedBranches": false
  }
}
```

| Field | Default | Description |
|---|---|---|
| `enable` | `false` | when off, work directly on `companyBranch` |
| `strategy` | `feature` | `feature` / `release` / `hotfix` / `develop` (lowercase) |
| `baseBranch` | `main` | starting branch; must exist, otherwise it errors |
| `branchPattern` | `feature/sync-{date}` | supports `{date}` (`YYYY-MM-DD`), `{base}`, `{strategy}`; backslashes are normalised to `/`; other brace placeholders are kept literally |
| `autoSwitchBack` | `true` | after the working commit is done, switch back to the branch you were on before the run; with a detached HEAD it does not switch back. PR mode always switches back, because the target branch was never touched |
| `autoDeleteMergedBranches` | `false` | when on, deletes sync branches that were generated by this tool, are already merged into `companyBranch`, and are not currently checked out. Only the prefix before the first `{` of `branchPattern` is recognised (for example `feature/sync-`), so a pattern without a placeholder deletes nothing; the target branch and `baseBranch` are never deleted; unmerged branches cannot be deleted |

Preview mode does not apply the branch strategy and does not switch branches.

## grayReleaseConfig

```json
{
  "grayReleaseConfig": {
    "enable": true,
    "strategy": "percentage",
    "percentage": 20,
    "canaryDirs": ["packages/shared"],
    "filePatterns": ["*.json"],
    "validationScript": "pnpm typecheck",
    "maxRetries": 0,
    "rollbackOnFailure": false,
    "auditLogPath": ".sync-gray-audit.jsonl",
    "enableMonitoring": false,
    "monitorInterval": 5000,
    "alertThresholds": { "errorRate": 0.1, "performanceDrop": 30, "maxExecutionTime": 120000 }
  }
}
```

| Field | Description |
|---|---|
| `enable` | must be `true` for the gray-release controller to be created |
| `strategy` | `percentage` / `directory` / `file` (lowercase) |
| `percentage` | `(0, 100]`; buckets paths deterministically, so re-running the same plan selects the same set |
| `canaryDirs` | required non-empty for the `directory` strategy; matches the sync directory a change belongs to |
| `filePatterns` | required non-empty for the `file` strategy; `*.ext` matches by suffix, patterns containing `/` match by path suffix, otherwise match the file name exactly |
| `validationScript` | command run at the repository root; a non-zero exit counts as validation failure |
| `maxRetries` | number of validation retries (`?? 0`, i.e. no retry by default) |
| `rollbackOnFailure` | whether to roll back automatically on validation failure, default `false` |
| `auditLogPath` | JSONL path relative to the repository root, default `.sync-gray-audit.jsonl` |
| `enableMonitoring` / `monitorInterval` / `alertThresholds` | sample failure rate and duration and emit alerts, logging only |

Stages: `idle` → `canary` → `validating` → `completed` / `failed` / `rolled-back`.
An empty selected set, a missing or out-of-range `percentage`, and missing parameters for the `directory`/`file` strategies all error out directly (`percentage` defaults to 20 via the CLI, but must be given explicitly in the config file).

Two combination limits: multi-upstream fan-in (`upstreams`) and gray release are mutually exclusive — `-gr` / `-fr` / `-ro` error out directly when there is more than one source; and while a gray release is enabled, rename detection is switched off with a warning, so renames are handled as delete + add.

## webhookConfig

```json
{
  "webhookConfig": {
    "enable": true,
    "host": "127.0.0.1",
    "port": 3000,
    "path": "/webhook",
    "secret": "…",
    "allowedEvents": ["push"],
    "triggerBranch": "main",
    "supportedPlatforms": ["github"],
    "healthPath": "/healthz",
    "deduplicate": true,
    "deliveryLog": ".sync-webhook-deliveries.jsonl",
    "maxQueue": 8,
    "maxBodyBytes": 1048576,
    "retryConfig": { "maxRetries": 2, "initialDelay": 1000, "backoffFactor": 2 },
    "securityConfig": {
      "ipWhitelist": ["127.0.0.1", "10.0.0.0/8"],
      "rateLimit": { "maxRequestsPerSecond": 5, "statusCode": 429, "message": "请求过于频繁" }
    },
    "eventFilterConfig": {
      "rules": [
        { "eventType": "push", "conditions": [{ "fieldPath": "ref", "operator": "eq", "value": "refs/heads/main" }] }
      ]
    }
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `enable` | `boolean` | required | when true the process stays resident as a daemon and no one-off sync runs |
| `host` | `string` | `127.0.0.1` | bind address; serving anything beyond this machine needs an explicit `0.0.0.0`. Listening externally with neither TLS nor an allowlist makes `doctor` warn |
| `port` | `number` | required | 0–65535; `0` lets the system assign one and the actual port is printed in the log |
| `path` | `string` | required | must start with `/`; accepts POST only |
| `secret` | `string` | required, non-empty | an empty value is rejected during configuration validation (`启用 webhook 时 webhookConfig.secret 不能为空` — "secret cannot be empty when the webhook is enabled", exit code 2); a server started through the library without that validation answers every request with `401`, see the [webhook daemon](/en/guide/webhook#request-handling-order) |
| `allowedEvents` | `string[]` | — | event allowlist, the first coarse filter step |
| `triggerBranch` | `string` | — | only events on this branch trigger (compares the short name after stripping `refs/heads/`) |
| `supportedPlatforms` | platform array | — | `github` / `gitlab` / `bitbucket` / `gitea`; when only one platform is listed, a missing platform-identifying header is tolerated |
| `tlsCert` / `tlsKey` | `string` | unset | the certificate and private key **file paths** (resolved against the current directory), which must be given as a pair; with the pair present the service runs over HTTPS |
| `trustProxy` | `boolean` | `false` | enable it only when you really are behind a trusted reverse proxy; only then does the first hop of `x-forwarded-for` take part in the IP allow-list and rate-limit decisions |
| `maxBodyBytes` | `number` | `1048576` (1 MiB) | request body cap (an integer of at least 1024); over the limit returns 413 and closes the connection |
| `healthPath` | `string` / `false` | `/healthz` | GET/HEAD on this path is the liveness probe; it answers whether the daemon is exiting, how many syncs are running, the queue limit, the delivery counters and the last delivery; `false` disables it |
| `deduplicate` | `boolean` | `true` | a delivery id already handled (a platform redelivery) does not trigger a second sync; it gets a 200 with the reason |
| `deliveryLog` | `string` | unset | one JSONL audit line appended per delivery received; relative paths resolve against the current directory. Unset produces a warning — once the process exits, the delivery decisions cannot be reviewed |
| `seenStateFile` | `string` | `<deliveryLog>.seen.json` | the file that remembers across restarts which delivery ids were already handled; with neither this nor `deliveryLog` set, deduplication happens in memory only |
| `seenHistory` | `number` | `512` | how many ids that file keeps (an integer greater than 0); the oldest are dropped first |
| `maxQueue` | `number` | `8` | how many syncs may queue for the repository lock (integer 1–1000); once it is full new deliveries get 503, so the platform redelivers later instead of silently holding a 202 that leads nowhere |
| `securityConfig.ipWhitelist` | `string[]` | unset (no restriction) | supports exact IPs and CIDR; an empty list means no restriction |
| `securityConfig.rateLimit` | object | unset (off) | token bucket, counted per client IP; `maxRequestsPerSecond ≤ 0` disables it |
| `eventFilterConfig.rules` | array | unset | per-event fine-grained conditions; once an event has any rule, at least one must match |
| Condition operators | — | — | `eq` / `ne` / `gt` / `lt` / `contains` / `regex`; `fieldPath` is a dotted path, doing property traversal only and executing no code |

Signature schemes: GitHub/Gitea use `x-hub-signature-256` (`sha256=<hmac>`), Bitbucket uses `x-hub-signature` (also requiring `sha256=`), GitLab uses `x-gitlab-token` as a plain-text comparison. All of them use constant-time comparison, and the failure reason never includes the secret value.

The delivery audit records only the shape of a delivery (time, platform, event, branch, decision, reason, response status code, duration, normalised client address), never the request body — push events carry commit messages and author email addresses. `--webhook-log <path>` writes `deliveryLog`, `--webhook-queue <n>` writes `maxQueue`, `--webhook-host` writes `host`; every remaining field can only be set in the configuration file.

## logConfig

Writes the log into a rotating file as well. **With this section omitted the log goes to the console only**, which is exactly what a one-off sync wants; a daemon and a long-running CI job are the cases that need it on disk.

```json
{
  "logConfig": {
    "file": "logs/sync-upstream.log",
    "level": "info",
    "json": false,
    "maxBytes": 5242880,
    "keep": 5
  }
}
```

| Field | Type | Default | Command line | Description |
|---|---|---|---|---|
| `file` | `string` | unset (no file output) | `--log-file` | the log is appended to this file as well; relative paths resolve against the current working directory, and missing directories are created |
| `level` | `debug` / `info` / `warn` / `error` | `info` | `--log-level` | the lowest level that reaches the file. Console levels such as `verbose` and `success` are mapped to the closest of these four when written to the file |
| `json` | `boolean` | `false` | `--log-json` / `--no-log-json` | one JSON object per line (`at`, `level`, `message`, plus `context` when there is context) instead of the `[time] [level] text` format |
| `maxBytes` | `number` | `5242880` (5 MiB) | `--log-max` | rotate once the file passes this many bytes (an integer of at least 1024) |
| `keep` | `number` | `5` | `--log-keep` | how many rotated files to keep (0–100); `<file>.1` is the newest. `0` keeps no history and starts over |
| `redact` | `string[]` | `[]` | — | extra literals to scrub from the file beyond the automatic masking; every item must be a non-empty string |

Before anything reaches the file, colour codes are stripped and values such as URL credentials, `token=` / `secret=` / `Bearer …` are masked; the webhook `secret` and credential-like configuration entries are added to the masking list automatically. The console and the file are independent: `verbose` / `silent` affect the console only. A rotation or write failure prints one line on the console and never interrupts the sync.

## notifyConfig

After the run finishes, the result is announced: console, generic HTTP, Slack, DingTalk, WeCom.

```json
{
  "notifyConfig": {
    "enable": true,
    "channels": ["stdout", "slack", "dingtalk"],
    "slackUrl": "https://hooks.slack.com/services/…",
    "dingtalkUrl": "https://oapi.dingtalk.com/robot/send?access_token=…",
    "dingtalkSecret": "SEC…",
    "events": ["success", "conflict", "failure", "undo"],
    "timeoutMs": 5000,
    "retries": 2,
    "template": "sync-upstream {outcome}：{upstreamBranch} → {companyBranch}，{files} 个文件，冲突 {conflicts}"
  }
}
```

| Field | Type | Default | Command line | Description |
|---|---|---|---|---|
| `enable` | `boolean` | `false` | `--notify` sets it true, `--no-notify` false | master switch |
| `channels` | array of `stdout` / `http` / `slack` / `dingtalk` / `wecom` | `[]` | `--notify <a,b>` | must not be empty when enabled; a channel missing its URL is skipped with the reason given, which is not an error |
| `url` | `string` | unset | `--notify-url` | the generic HTTP channel: one JSON POST per event, must be http(s) |
| `headers` | `object` | unset | — | extra request headers, for example `{ "authorization": "Bearer …" }` |
| `slackUrl` / `dingtalkUrl` / `wecomUrl` | `string` | unset | — | the per-platform bot addresses, which must be http(s) |
| `dingtalkSecret` | `string` | unset | — | the DingTalk bot's signing secret; without it the platform rejects the delivery |
| `events` | array of `success` / `noop` / `conflict` / `failure` / `undo` | everything except `noop` | `--notify-events` | which outcomes are announced. `noop` is a run whose plan came out empty and is silent by default — a daemon on a busy repository should not message on every push |
| `timeoutMs` | `number` | `5000` | — | cap for a single request (an integer of at least 500); a dead endpoint cannot hang your command |
| `retries` | `number` | `2` | — | attempts per channel (1–5, including the first) |
| `template` | `string` | unset | — | custom text; when omitted the default multi-line summary is used. Placeholders: `{outcome}` `{upstream}` `{upstreamBranch}` `{companyBranch}` `{commit}` `{files}` `{kept}` `{conflicts}` `{skipped}` `{error}` `{duration}` `{dirs}` `{prBranch}` `{prUrl}`; an unrecognised placeholder is kept literally |
| `includeDetails` | `boolean` | `true` | — | whether the default text appends example file paths (a few at most, never the full list) |
| `retryConfig` | `RetryConfig` | unset | — | only the retry interval is used; it defaults to 500ms |

Put addresses and secrets in the configuration file rather than on the command line — other processes on the same machine can read command arguments. The upstream URL in an announcement is always redacted; in PR mode the target branch was not touched, so the message carries the branch name and the review entry point instead of announcing something nobody can merge.

## prConfig

The GitOps usage: the changes do not land on the target branch but are committed to an auto-generated branch, pushed, and handed to you as a PR to review.

```json
{
  "prConfig": {
    "enable": true,
    "branchPattern": "sync-upstream/{target}-{date}",
    "remote": "origin",
    "title": "Sync upstream main",
    "body": "自动同步，评审后合并。",
    "draft": true,
    "create": "auto"
  }
}
```

| Field | Type | Default | Command line | Description |
|---|---|---|---|---|
| `enable` | `boolean` | `false` | `--pr` / `--no-pr` | master switch |
| `branchPattern` | `string` | `sync-upstream/{target}-{date}` | `--pr-branch` | `{target}` is the target branch name and `{date}` is `yyyymmdd`; when the resulting name already exists, `-2`, `-3` are appended automatically and an old branch is never reused |
| `remote` | `string` | the upstream the target branch tracks, otherwise `origin` | `--pr-remote` | which remote the branch is pushed to; with no remote at all it errors out |
| `title` | `string` | unset (an automatically generated title) | `--pr-title` | the PR title |
| `body` | `string` | unset | `--pr-body` | a note appended after the automatically generated description |
| `draft` | `boolean` | `false` | `--pr-draft` | create the PR as a draft |
| `create` | `auto` / `never` | `auto` | `--pr-no-create` (= `never`) | `auto` really opens the PR when `gh` / `glab` is installed on the machine; `never` only pushes the branch and prints the compare link |
| `tool` | `gh` / `glab` | chosen from the remote host | — | explicitly pick which command-line tool to use |

Key points:

- Without the corresponding command-line tool the branch is still pushed and the compare link printed; opening the PR can never make the sync fail.
- Mutually exclusive with preview (`-P` / `-n`), `branchStrategyConfig` and `grayReleaseConfig`; combining them is a validation error.
- The target branch is not pushed: `autoPush` is switched off with a warning.
- A PR-mode run neither reads nor writes the incremental state — the changes have not reached the target branch, and recording them would make the next sync wrongly conclude "already synced".

## Runtime files and cleanup

What the tool leaves in your repository:

| Artefact | When it appears | Purpose | When you need to care |
|---|---|---|---|
| `sync-upstream.config.json` (or the format and path given by `-F` / `-C`) | only after `--generate-config` or `init` | the configuration template, or the config your questionnaire answers produced; every later run reads it | yours to keep, commit and edit; the tool never rewrites it, and you can delete it if you do not want it |
| `.sync-state.json` (repository root) | after every real sync | the baseline for incremental sync: for each synced path the upstream content hash, mode bits and timestamp, plus the last 50 sync records | invalidated and rebuilt automatically when you change the upstream repository, upstream branch or target branch, so no manual cleanup is needed; deleting it just costs one extra full comparison. `--undo` and `history` depend entirely on the sync records inside it, so once it is gone you cannot undo |
| `.sync-state-<ref>-<8-char hash>.json` (repository root) | when `upstreams` is configured, one per upstream | as above, one per upstream, so sources cannot mark each other's work as "already synced" | as above; the name follows the upstream URL and ref, so one `.sync-state-*.json` entry in `.gitignore` covers them all |
| `.sync-gray.json` (repository root) | during a gray release | gray-release progress: which files are released, which are pending, where the rollback point is | **do not delete** while a gray release is in progress; `--full-release` and `--rollback` depend on it entirely; it is deleted automatically after a full release succeeds |
| `.sync-gray-audit.jsonl` (repository root) | during a gray release | append-only audit trail of gray-release stages | pure logging, deleting it affects neither sync nor rollback; the path can be changed via `grayReleaseConfig.auditLogPath` |
| `.git/sync-upstream.lock` | while a sync, an undo, or a gray release runs | the repository lock: two syncs in the same working directory would step on each other's `checkout`, index and commits | removed automatically when a run ends normally. When a killed process leaves it behind: a holder that has exited is taken over immediately, and a lock older than 30 minutes is taken over automatically as well; `doctor` reports the holder and its creation time, and you can delete the file by hand |
| the file `<webhookConfig.deliveryLog>` points at | only in daemon mode with `deliveryLog` configured | one JSONL line appended per delivery: platform, event, branch, decision, reason, response status code, duration | pure logging, delete or rotate whenever you like; it contains neither the request body nor the secret |
| `<deliveryLog>.seen.json` (or the name given by `seenStateFile`) | only when the delivery audit is configured, or this path is set explicitly | remembers across restarts which delivery ids were already handled, so a platform redelivery cannot trigger a second sync | the only consequence of deleting it is losing the deduplication memory; the file keeps the most recent `seenHistory` ids |
| `logConfig.file` and `<file>.1` … `<file>.<keep>` | only when `logConfig.file` is set | the on-disk log and its rotation history, colour-stripped and masked before writing | your call how long to keep them; `keep: 0` keeps no history |
| the remote `sync-upstream` (plus `sync-upstream-2`, `-3` … with several upstreams) | corrected automatically on every run | the upstream repository entries in `.git/config` | you can `git remote remove sync-upstream` any time; the next run re-adds it |
| the branch generated automatically in PR mode | only when `prConfig.enable` is set | carries the changes of that run until review merges them | yours to dispose of; once merged or closed you can delete it |

With `pat` / `user_pass` authentication, these remote URLs carry the credentials. Therefore **do not commit `.git/config` or paste it into logs or issues**; with SSH or a credential helper the URL contains no secret. URLs in logs and errors are always redacted.

Neither the state files nor the gray-release files should be committed to version control; put them in your project's `.gitignore`:

```text
.sync-state.json
.sync-state-*.json
.sync-gray.json
.sync-gray-audit.jsonl
```

### Files the tool creates

The built-in ignore rules guarantee that the following paths never enter the sync plan: `.git/`, `node_modules/`, `.DS_Store`, `.sync-state.json`, plus the leftovers from older versions `.sync-cache/`, `.sync-temp/`, `.sync-hashes.json` (the current version neither reads nor writes them, so you can delete them directly).

Not on the ignore list, though: **`.sync-gray.json`, `.sync-gray-audit.jsonl` and the multi-upstream `.sync-state-*.json`**, nor are `dist/` and `build/` (they may be real artefacts that need syncing). So if you treat the repository root `.` as a sync directory and upstream happens to have files with the same names, your local gray-release records get overwritten by the upstream versions. Keep the sync scope limited to real source directories, or add these names to `.syncignore`, to avoid this.

The overlay order of ignore rules (built-in → root `.gitignore` → `.syncignore` → config entries → nested `.gitignore` inside sync directories, the latter taking priority) is in the [configuration guide](/en/guide/configuration).

## Removed keys and new aliases

The three keys below no longer exist. Writing them has no effect any more, but they do not fail silently either — the run prints one "deprecated and ignored" warning and says what decides the behaviour now:

| Key | What it relies on now |
|---|---|
| `cache` | incremental decisions use the content hash git records; the state file itself is the basis of the decision, and there is no separate cache layer |
| `cacheConfig` | same as above |
| `adaptiveConcurrency` | concurrency is controlled by `concurrencyLimit` alone; there is no adaptive tuning |

The fields newly documented on this page also have historical spellings, which are rewritten automatically with one warning (the full list is in [the aliases section of the configuration guide](/en/guide/configuration#aliases-and-removed-keys)):

| What you write | What takes effect |
|---|---|
| `deletions` | `deletePolicy` |
| `renames`, `findRenames` | `renameDetection` |
| `fetch`, `clone` | the whole `fetchConfig` section |
| `partialClone`, `cloneFilter` | `fetchConfig.filter` |
| `fetchDepth` | `fetchConfig.depth` |
| `fetchTags` | `fetchConfig.tags` |
| `lfs`, `lfsMode` | `fetchConfig.lfs` |
| `log`, `logging` | the whole `logConfig` section |
| `logFile` | `logConfig.file` |
| `logLevel` | `logConfig.level` |
| `logJson` | `logConfig.json` |
| `logMaxBytes`, `logRotate` | `logConfig.maxBytes` |
| `logKeep` | `logConfig.keep` |
| `pr`, `pullRequest` | the whole `prConfig` section |
| `notify`, `notifications` | the whole `notifyConfig` section |
| `webhookLog` | `webhookConfig.deliveryLog` |
| `webhookQueue` | `webhookConfig.maxQueue` |

An alias with the wrong value type (for example `maxRetries: "abc"`) is a hard error and stops the run; a correctly spelled canonical key is never reported as an unrecognised configuration option.

## Related pages

- [Configuration guide](/en/guide/configuration): layering, discovery order, aliases, ignore-rule overlay
- [CLI reference](/en/reference/cli): the flag and default behind each field
- [Usage overview](/en/guide/usage): entry points to the topic pages (sync, conflicts, gray release, Webhook, CI)
- [API reference](/en/reference/api): programmatic entry points and types
