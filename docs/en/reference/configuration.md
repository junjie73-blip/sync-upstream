# Configuration Reference

This page lists the canonical fields of `SyncConfig` one by one. The config file, the command line, and the programmatic API all use the **same key names**; historical aliases are covered in [the aliases section of the configuration guide](/en/guide/configuration#aliases-and-removed-keys).

The types are defined in `src/domain/` and can be imported straight from the package:

```ts
import type { GrayReleaseConfig, SyncConfig, WebhookConfig } from 'sync-upstream'
```

## Top-level fields

| Field | Type | Default | Command line | Description |
|---|---|---|---|---|
| `upstreamRepo` | `string` | `''` (required) | `-r, --repo` | upstream repository URL |
| `upstreamBranch` | `string` | `'main'` | `-b, --branch` | upstream branch |
| `companyBranch` | `string` | `'main'` | `-c, --company-branch` | target branch (must already exist locally / on `origin`) |
| `syncDirs` | `string[]` | `[]` (required, non-empty) | `-d, --dirs` | sync scope, paths relative to the repository root |
| `commitMessage` | `string` | `'Sync upstream changes to specified directories'` | `-m, --message` | commit message |
| `autoPush` | `boolean` | `false` | `-p, --push` | push after committing; forced off with a warning when `dryRun` is true |
| `forceOverwrite` | `boolean` | `true` | `-f, --force` / `--incremental` | `true` applies the whole plan; `false` goes incremental based on `.sync-state.json` |
| `verbose` | `boolean` | `false` | `-V, --verbose` | raises the log level and prints the full change list |
| `silent` | `boolean` | `false` | `-s, --silent` | print errors only |
| `dryRun` | `boolean` | `false` | `-n, --dry-run` | dry run, equivalent to `previewOnly` |
| `previewOnly` | `boolean` | `false` | `-P, --preview-only` | print the plan only |
| `nonInteractive` | `boolean` | `false` | `-y, --non-interactive` | ask nothing; `prompt-user` degrades to `keep-target` |
| `concurrencyLimit` | `number` | `10` | `--concurrency` | concurrency of the per-path retry after a batch apply failure |
| `includeFileTypes` | `string[]` | `[]` | `--include-types` | extension allowlist; empty means no filtering |
| `ignorePatterns` | `string[]` | `[]` | `--ignore` | appended ignore rules (gitignore syntax) |
| `retryConfig` | `RetryConfig` | see below | `--retry-*` | retries for network-class operations such as fetch |
| `conflictResolutionConfig` | `ConflictResolutionConfig` | see below | `--conflict-strategy` | conflict handling |
| `authConfig` | `AuthConfig?` | unset | `--auth-*` | credentials for accessing upstream |
| `branchStrategyConfig` | `BranchStrategyConfig?` | unset (the `-g` generated default has `enable: false`) | — | sync on a derived branch |
| `grayReleaseConfig` | `GrayReleaseConfig?` | unset | `-gr`, etc. | gray release |
| `webhookConfig` | `WebhookConfig?` | unset | `-we`, etc. | Webhook daemon mode |
| `fullRelease` | `boolean` | `false` | `-fr, --full-release` | release the remaining gray-release files |
| `rollback` | `boolean` | `false` | `-ro, --rollback` | roll back the gray release on record |

Boolean fields such as `verbose`, `silent`, and `dryRun` are only written at the command-line layer when the flag is present, so a `true` in the config file is not reset to `false` by a command line that omits the flag.

## Accepted shapes for `upstreamRepo`

| Form | Example |
|---|---|
| HTTPS / HTTP | `https://github.com/org/repo.git` |
| SSH URL | `ssh://git@github.com/org/repo.git` |
| git / file protocols | `git://host/repo.git`, `file:///srv/repo` |
| scp-style | `git@github.com:org/repo.git` (normalised internally to `ssh://`) |
| local path | `/srv/repo`, `../vendor/repo`, `J:\vendor\repo` |

Local paths are handy for testing and offline scenarios: upstream can be another repository on your own disk.

## retryConfig

```json
{ "retryConfig": { "maxRetries": 3, "initialDelay": 2000, "backoffFactor": 1.5 } }
```

| Field | Constraint | Meaning |
|---|---|---|
| `maxRetries` | integer ≥ 0 | number of retries beyond the first attempt |
| `initialDelay` | ≥ 0 | milliseconds to wait before the first retry |
| `backoffFactor` | ≥ 1 | the n-th wait is `initialDelay × factor^(n-1)` |

A retry only happens when the error message matches "network-class" signatures (`网络` meaning "network", `network`, `connect`, `resolve host`, `timed out`, `RPC failed`, `early EOF`, `无法访问` meaning "unreachable"/"cannot access", `不可达` meaning "not reachable", and so on); authentication failures and illegal paths rethrow the original error immediately. Once retries are exhausted the error is wrapped as `TimeoutError` or `NetworkError`.

Matching command-line flags: `--retry-max`, `--retry-delay`, `--retry-backoff` (each overridable independently, without affecting the others).

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
| `resolutionLogFile` | unset | declared in the type, but **unused by the current implementation**; decisions are not written to a separate file |

Strategy-to-action mapping: `use-source → take-upstream`, `keep-target → keep-local`, `skip → skip`, `auto-merge →` decided by the three-way merge result (it may produce a `write-merged` that still carries conflict markers).

Conflict types (`ConflictType`): `content`, `type`, `delete-modify`, `add-add`, `symlink`, `untracked-overwrite`, `unreadable`.

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
| `autoSwitchBack` | `true` | declared in the type, but **not read by the current implementation**: changes on the working branch are not switched back automatically; you commit on that branch directly for review |
| `autoDeleteMergedBranches` | `false` | declared in the type, but **not read by the current implementation**: the tool never deletes any branch automatically |

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

## webhookConfig

```json
{
  "webhookConfig": {
    "enable": true,
    "port": 3000,
    "path": "/webhook",
    "secret": "…",
    "allowedEvents": ["push"],
    "triggerBranch": "main",
    "supportedPlatforms": ["github"],
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

| Field | Description |
|---|---|
| `enable` | when true, runs as a persistent daemon instead of a one-off sync |
| `port` | 1–65535; `0` lets the system assign one and prints the actual port in the log |
| `path` | must start with `/`; accepts POST only |
| `secret` | required, non-empty; when empty every request gets 401 |
| `allowedEvents` | event allowlist, the first coarse filter step |
| `triggerBranch` | only events on this branch trigger a sync (compares the short name after stripping `refs/heads/`) |
| `supportedPlatforms` | `github` / `gitlab` / `bitbucket` / `gitea`; when only one platform is listed, a missing platform-identifying header is tolerated |
| `securityConfig.ipWhitelist` | supports exact IPs and CIDR; an empty list means no restriction |
| `securityConfig.rateLimit` | token bucket, counted per client IP; `maxRequestsPerSecond ≤ 0` disables it |
| `eventFilterConfig.rules` | per-event fine-grained conditions; once an event has any rule, at least one must match |
| Condition operators | `eq` / `ne` / `gt` / `lt` / `contains` / `regex`; `fieldPath` is a dotted path, doing property traversal only and executing no code |

The `message` under `rateLimit` above is the tool's actual default response text, `"请求过于频繁"` ("Too many requests"), returned with the rate-limit status code.

Signature schemes: GitHub/Gitea use `x-hub-signature-256` (`sha256=<hmac>`), Bitbucket uses `x-hub-signature` (also requiring `sha256=`), GitLab uses `x-gitlab-token` as a plain-text comparison. All of them use constant-time comparison, and the failure reason never includes the secret value.

The request body is capped at 1 MiB; exceeding it returns 413 and closes the connection.

## Runtime files and cleanup

The tool leaves four kinds of artefacts in your repository:

| Artefact | Purpose | When you need to care |
|---|---|---|
| `.sync-state.json` | baseline for incremental sync: records the upstream content and timestamp for each synced path | automatically invalidated and rebuilt when you change the upstream repo or branch, no manual cleanup needed; deleting it just costs one extra full comparison |
| `.sync-gray.json` | gray-release progress: which files are released, which are pending, where the rollback point is | **do not delete** while a gray release is in progress; `--full-release` and `--rollback` depend on it entirely; it is deleted automatically after a full release succeeds |
| `.sync-gray-audit.jsonl` | append-only audit trail of gray-release stages | pure logging, deleting it affects neither sync nor rollback; the path can be changed via `grayReleaseConfig.auditLogPath` |
| remote `sync-upstream` | a remote entry in `.git/config`, corrected automatically on every run | you can `git remote remove sync-upstream` any time; the next run re-adds it |

With `pat` / `user_pass` authentication, this remote's URL carries the credentials. Therefore **do not commit `.git/config` or paste it into logs or issues**; with SSH or a credential helper the URL contains no secret. URLs in logs and errors are always redacted.

Neither `.sync-state.json` nor `.sync-gray.json` should be committed to version control; add them to your project's `.gitignore`.

### Files the tool creates

The built-in ignore rules guarantee the following paths never enter the sync plan: `.git/`, `node_modules/`, `.sync-state.json`, plus the legacy `.sync-cache/`, `.sync-temp/`, `.sync-hashes.json` from older versions (the current version neither reads nor writes them, so you can delete them directly).

Two exceptions: **`.sync-gray.json` and `.sync-gray-audit.jsonl` are not in the ignore list**, nor are `dist/` and `build/` (they may be real artefacts that need syncing). So if you treat the repository root `.` as a sync directory and upstream happens to have files with the same names, your local gray-release records get overwritten by the upstream versions. Keep the sync scope limited to real source directories, or add these names to `.syncignore`, to avoid this.

The overlay order of ignore rules (built-in → root `.gitignore` → `.syncignore` → config entries → nested `.gitignore` inside sync directories, the latter taking priority) is in the [configuration guide](/en/guide/configuration).

## Related pages

- [Configuration guide](/en/guide/configuration): layering, discovery order, aliases, ignore-rule overlay
- [CLI reference](/en/reference/cli): the flag and default behind each field
- [Usage overview](/en/guide/usage): entry points to the topic pages (sync, conflicts, gray release, Webhook, CI)
- [API reference](/en/reference/api): programmatic entry points and types
