# Configuration guide

Configuration for one run resolves through three layers of config precedence, and each later layer overrides the previous one:

```
Defaults (src/config/defaults.ts)  <  Config file  <  CLI flags
```

Nested objects are merged field by field, so `--retry-delay 5000` only changes the delay; it does not wipe out `retryConfig.maxRetries` from the config file. Arrays and scalars are replaced wholesale.

## Where configuration comes from

An explicit path wins:

```bash
sync-upstream -C config/sync.json
```

A file named by `-C` **aborts the run when it cannot be read**; it never falls back to defaults. A wrong path, missing read permission, broken syntax, empty content, and a top level that is not an object each produce a different error, and when parsing fails the failure reason for every JSON / YAML / TOML attempt is listed together.

Without `-C`, the first existing file in the current directory is picked, searched in this order:

```
sync-upstream.config.json   sync-upstream.config.json5
sync-upstream.config.yaml   sync-upstream.config.yml
sync-upstream.config.toml
sync-upstream.json          sync-upstream.json5
sync-upstream.yaml          sync-upstream.yml
sync-upstream.toml
.sync-toolrc.json5          .sync-toolrc.json
.sync-toolrc.yaml           .sync-toolrc.yml
.sync-toolrc.toml           .sync-toolrc
```

If none of them is found, defaults are used and a warning is printed that names every file name that was looked for.

The format is decided by the extension; the extension-less `.sync-toolrc` is tried as JSON → YAML → TOML in turn.

## Generate a starting point

```bash
sync-upstream -g                       # writes sync-upstream.config.json
sync-upstream -g -F yaml               # writes sync-upstream.config.yaml
sync-upstream -g -C config/sync.toml -F toml
```

What gets written out is the complete set of defaults; delete the fields you do not need.

## Minimal working configuration

Only two items have to come from you: `upstreamRepo` and `syncDirs`. Both branch fields default to `main`, but with cross-team work it is worth writing them out explicitly:

```json
{
  "upstreamRepo": "https://github.com/vuejs/core.git",
  "upstreamBranch": "main",
  "companyBranch": "company/main",
  "syncDirs": ["packages/shared"]
}
```

`syncDirs` must be a **non-empty array of strings**, and every item is a path relative to the repository root: it may not start with `/`, may not be an absolute path, may not contain `..`, and may not contain consecutive separators. Matching works on whole path segments: a directory covers everything below it, and **an entry may also be the path of a single file** (for example `["package.json"]`).

## YAML

```yaml
upstreamRepo: https://github.com/vuejs/core.git
upstreamBranch: main
companyBranch: company/main
syncDirs:
  - packages/runtime-core
  - packages/shared
ignorePatterns:
  - '**/__tests__/**'
  - '*.snap'
includeFileTypes: [.ts, .md]
concurrencyLimit: 10
forceOverwrite: true
autoPush: false
retryConfig:
  maxRetries: 3
  initialDelay: 2000
  backoffFactor: 1.5
conflictResolutionConfig:
  defaultStrategy: auto-merge
  autoResolveTypes: [.md]
  logResolutions: true
```

## TOML

```toml
upstreamRepo = "https://github.com/vuejs/core.git"
upstreamBranch = "main"
companyBranch = "company/main"
syncDirs = [
  "packages/runtime-core",
  "packages/shared"
]
concurrencyLimit = 10

[retryConfig]
maxRetries = 3
initialDelay = 2000
backoffFactor = 1.5

[conflictResolutionConfig]
defaultStrategy = "prompt-user"
logResolutions = true
```

## Validation rules

Once the config layers are merged, everything is validated in one pass and **all problems are reported at once** — you never fix one only to be told about the next. What gets checked:

| Field | Rule |
|---|---|
| `upstreamRepo` | Non-empty, and a recognisable repository URL: `https://`, `http://`, `ssh://`, `git://`, `file://`, the scp form `git@host:org/repo.git`, or a local path (absolute / `./` / `../` / Windows drive letter) |
| `upstreamBranch` / `companyBranch` | Non-empty |
| `syncDirs` | Non-empty array, with a path-legitimacy check on every item |
| `concurrencyLimit` | Integer ≥ 1 |
| `retryConfig.maxRetries` | Integer ≥ 0 |
| `retryConfig.initialDelay` | ≥ 0 |
| `retryConfig.backoffFactor` | ≥ 1 |
| `conflictResolutionConfig.defaultStrategy` | One of `use-source` / `keep-target` / `auto-merge` / `prompt-user` / `skip` (lowercase, hyphenated) |
| `branchStrategyConfig` | When enabled, `strategy` ∈ `feature` / `release` / `hotfix` / `develop`, and `baseBranch` and `branchPattern` are non-empty |
| `grayReleaseConfig` | When `strategy = percentage`, `percentage` ∈ `(0, 100]` |
| `webhookConfig` | When enabled, `port` is an integer in 1–65535, `path` starts with `/`, and `secret` is non-empty |

A validation failure is exit code 2. There is also one rule that is corrected automatically with a warning instead: when `dryRun` and `autoPush` are both true, `autoPush` is switched off (a dry run must not push).

## Aliases and removed keys

Legacy spellings are rewritten automatically and a warning is raised, for example:

| What you write | What actually takes effect |
|---|---|
| `repo` / `upstreamUrl` / `upstream` | `upstreamRepo` |
| `branch` / `upstreamRef` | `upstreamBranch` |
| `targetBranch` / `downstreamBranch` / `baseBranch` | `companyBranch` |
| `dirs` / `syncDirectories` / `directories` | `syncDirs` |
| `message` | `commitMessage` |
| `push` | `autoPush` |
| `force` | `forceOverwrite` |
| `fileTypes` | `includeFileTypes` |
| `ignore` | `ignorePatterns` |
| `maxParallelFiles` / `parallel` | `concurrencyLimit` |
| `maxRetries` / `retryMax` | `retryConfig.maxRetries` |
| `initialRetryDelay` / `retryDelay` | `retryConfig.initialDelay` |
| `retryDelayFactor` / `retryBackoff` | `retryConfig.backoffFactor` |
| `previewMode` / `preview` | `previewOnly` |
| `yes` | `nonInteractive` |
| `grayRelease` / `conflictResolution` / `webhook` / `branchStrategy` | The matching `*Config` object |

Alias values are type-coerced, and a coercion that cannot succeed is a hard error (for example `maxRetries: "abc"` → `配置项 maxRetries 需要数字`, i.e. "config item maxRetries must be a number").

These keys were removed as part of the rewrite; writing them only earns a removed-key warning: `cache`, `cacheConfig`, `adaptiveConcurrency` (concurrency is decided solely by `concurrencyLimit`).

Unrecognised keys are not dropped silently; you get `未识别的配置项 xxx 已忽略（拼写错误不会产生任何效果）` — "unrecognised config item xxx was ignored (a typo would have no effect at all)".

## Where ignore rules live

Ignore sources stack by precedence, and the later the source the higher it ranks (`src/fsx/ignore-source.ts`):

1. Built-in rules: `.git/`, `node_modules/`, `.sync-cache/`, `.sync-temp/`, `.sync-hashes.json`, `.sync-state.json`, `.DS_Store`
2. The `.gitignore` at the repository root
3. The `.syncignore` at the repository root (tool-specific, so it does not pollute git's ignore semantics)
4. `ignorePatterns` in the configuration
5. Nested `.gitignore` files inside each sync scope directory (the deeper the level, the later it is evaluated, so it wins)

The syntax is gitignore semantics: `#` comments, `!` negation, a trailing `/` matches directories only, a leading `/` anchors the pattern, `**` crosses directories. Note that the built-in rules **deliberately exclude** `dist`/`build` — those are real project artefacts, and whether they get synced is your call.

## Next steps

For field-by-field details see the [configuration reference](/en/reference/configuration), for flag-by-flag details the [CLI reference](/en/reference/cli), and for the command actions the [usage overview](/en/guide/usage).
