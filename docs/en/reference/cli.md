# CLI Reference

This page lists every `sync-upstream` command-line flag, subcommand, alias, default value, and the configuration key each one writes. See the [configuration reference](/en/reference/configuration) for what the fields mean and the [usage guide](/en/guide/usage) for scenarios.

## Parsing and precedence

Configuration is a deep merge of three layers, each overriding the previous one:

```text
defaults  →  config file  →  command line
```

The command line only overrides a config value for the flags you actually passed; an absent flag never erases what the file says. Nested objects (`retryConfig`, `conflictResolutionConfig`, `grayReleaseConfig`, `webhookConfig`, `fetchConfig`, `logConfig`, `notifyConfig`, `prConfig`) merge key by key, while arrays (`syncDirs`, `ignorePatterns`, `includeFileTypes`) are replaced as a whole.

The command handles flags and run intents in a fixed order:

```text
1. Language        --lang → SYNC_UPSTREAM_LANG → LC_ALL → LANG → LANGUAGE, Chinese if none
2. --version         print the version, exit code 0
3. --help            print help in the language just resolved, exit code 0
4. --generate-config write a config template and exit (other flags are not validated)
5. completion        print a shell completion script and exit
6. init              guided config-file wizard, then exit
7. status/why/doctor/history  read-only subcommands, print a report
8. unknown-flag check  any unknown flag → error, exit code 2
9. read config file + merge the command line + validate
10. apply log level and log-file settings
11. interactive completion (unless -y and the config is complete)
12. print the config summary
13. webhookConfig.enable → daemon mode; otherwise run the sync
```

Because steps 2-7 come before the unknown-flag check, `sync-upstream -g --not-a-flag` still writes the template instead of failing.

## Language (`--lang`)

Help text, argument errors and error messages all follow the active locale: `zh` or `en`.

| How | Effect |
|---|---|
| `--lang en` | English for this run |
| `SYNC_UPSTREAM_LANG=en` | The one switch that only means this tool; highest-priority variable |
| `LC_ALL` / `LANG` / `LANGUAGE` | Used when nothing above is set; `zh*` means Chinese, any other recognised locale means English |
| Nothing set, or only `C` / `POSIX` | Chinese (the default); the tool does not look for the system locale anywhere else |

`--lang` is only for the i18n layer: it is never written into the config and has no config key. An unrecognised value (`--lang klingon`) is reported **in the language you already had**, and the locale stays unchanged. `sync-upstream --lang en --help` is the quickest way to find out which language this machine gets.

## Subcommands

Besides the sync itself there are six subcommands; the first four are read-only and never touch the working tree or commit.

| Subcommand | Usage | Purpose |
|---|---|---|
| `status` | `sync-upstream status [--fetch] [--json]` | Current branch, upstream reachability, pending file count; no network without `--fetch` |
| `why` | `sync-upstream why <path inside the repo> [--json]` | Explain why one file would be synced, skipped or deleted |
| `doctor` | `sync-upstream doctor [--json]` | Health check: config, git, remotes, permissions, state files, lock |
| `history` | `sync-upstream history [--limit <n>] [--json]` | The most recent sync records |
| `init` | `sync-upstream init [-F yaml] [-C <path>] [-f]` | Generate a config file by asking questions |
| `completion` | `sync-upstream completion <bash\|zsh\|fish>` | Print a completion script, redirect it into your completion directory |

All six accept `--config` and `--lang`; the first four also accept `--json` for a machine-readable report.

Four of them — `status`, `doctor`, `history` and `--undo` — **still produce a report when there is no config file, or when the file is missing fields**, because they are exactly what you reach for when you do not yet know what is misconfigured. Each missing field is listed in the report's `warnings` array (printed to stderr in human mode), and `doctor` counts it as a blocking finding, exiting `1`. Only `why` still requires a usable configuration: its answer is "will this sync touch this file", and with no configuration there is no plan to answer from — it exits `2` with the validation failure.

## Flag table

String flags need a value, list flags take comma-separated values (and may be repeated; values are flattened and split on commas again).

| Long flag | Short | Type | Default | Config key written |
|---|---|---|---|---|
| `--repo` | `-r` | string | `''` | `upstreamRepo`; repeating `-r` expands into the `upstreams` array |
| `--branch` | `-b` | string | `main` | `upstreamBranch`; paired with `-r` by position, may be a branch, tag or commit |
| `--company-branch` | `-c` | string | `main` | `companyBranch` |
| `--dirs` | `-d` | list | `[]` | `syncDirs` |
| `--message` | `-m` | string | `Sync upstream changes to specified directories` | `commitMessage` |
| `--config` | `-C` | string | auto-discovered | Which config file to read; a read failure is fatal |
| `--config-format` | `-F` | string | `json` | Only affects what `--generate-config` and `init` produce |
| `--lang` | | string | from the environment | Not config; switches the output language |
| `--ignore` | | list | `[]` | `ignorePatterns` (appended, gitignore syntax) |
| `--include-types` | | list | `[]` | `includeFileTypes` (e.g. `.ts,.vue`) |
| `--concurrency` | | string→number | `10` | `concurrencyLimit` |
| `--lock-wait` | | string→number | `0` | `lockWaitMs`, how many milliseconds to wait for someone else's repository lock; `0` means fail immediately |
| `--retry-max` | | string→number | `3` | `retryConfig.maxRetries` |
| `--retry-delay` | | string→number | `2000` | `retryConfig.initialDelay` |
| `--retry-backoff` | | string→number | `1.5` | `retryConfig.backoffFactor` |
| `--conflict-strategy` | | string | `prompt-user` | `conflictResolutionConfig.defaultStrategy` |
| `--delete-policy` | | string | `mirror` | `deletePolicy`: `mirror`/`keep`/`ask` |
| `--rename-threshold` | | string→number | `60` | `renameThreshold`, similarity percentage |
| `--auth-type` | | string | none | `authConfig.type` |
| `--auth-username` | | string | none | `authConfig.username` |
| `--auth-token` | | string | none | `authConfig.token` |
| `--auth-password` | | string | none | `authConfig.password` |
| `--auth-key` | | string | none | `authConfig.privateKeyPath` |
| `--strategy` | | string | `percentage` | `grayReleaseConfig.strategy` |
| `--percentage` | | string→number | `20` | `grayReleaseConfig.percentage` |
| `--canary-dirs` | | list | none | `grayReleaseConfig.canaryDirs` |
| `--file-patterns` | | list | none | `grayReleaseConfig.filePatterns` |
| `--validation-script` | | string | none | `grayReleaseConfig.validationScript` |
| `--fetch-filter` | | string | `none` | `fetchConfig.filter`: `none`/`blob`/`tree` (`blob` is git's `--filter=blob:none`) |
| `--fetch-depth` | | string→number | none | `fetchConfig.depth`, shallow-clone depth |
| `--lfs` | | string | `pointer` | `fetchConfig.lfs`: `pointer`/`materialize`/`off` |
| `--notify` | | list | none | `notifyConfig.enable = true` plus `channels` |
| `--notify-url` | | string | none | `notifyConfig.url`, and adds the `http` channel automatically |
| `--notify-events` | | list | none | `notifyConfig.events` |
| `--pr-branch` | | string | none | `prConfig.branchPattern` |
| `--pr-remote` | | string | none | `prConfig.remote` |
| `--pr-title` | | string | none | `prConfig.title` |
| `--pr-body` | | string | none | `prConfig.body` |
| `--webhook-port` | | string→number | `3000` | `webhookConfig.port` (`0` picks a random port) |
| `--webhook-host` | | string | `127.0.0.1` | `webhookConfig.host` |
| `--webhook-path` | | string | `/webhook` | `webhookConfig.path` |
| `--webhook-secret` | | string | `''` | `webhookConfig.secret` |
| `--webhook-events` | | list | `push` | `webhookConfig.allowedEvents` |
| `--webhook-branch` | | string | `main` | `webhookConfig.triggerBranch` |
| `--webhook-log` | | string | none | `webhookConfig.deliveryLog`, the delivery audit file |
| `--webhook-queue` | | string→number | `8` | `webhookConfig.maxQueue` |
| `--log-file` | | string | none | `logConfig.file`, where to write logs |
| `--log-level` | | string | `info` | `logConfig.level` |
| `--log-max` | | string→number | `5242880` | `logConfig.maxBytes`, size cap per file |
| `--log-keep` | | string→number | `5` | `logConfig.keep`, how many rotated files to keep |
| `--limit` | | string→number | `10` | Only used by `history`; not written to config |

A boolean flag is `false` unless given. Besides the table below, `--no-delete`, `--no-renames`, `--no-pr`, `--no-fetch-tags` and `--no-notify` are supported (see "Negated forms").

| Long flag | Short | Effect |
|---|---|---|
| `--push` | `-p` | `autoPush = true` (there is no way to force it back to `false` from the command line) |
| `--force` | `-f` | `forceOverwrite = true` |
| `--incremental` | | `forceOverwrite = false`; wins when combined with `-f` |
| `--dry-run` | `-n` | `dryRun = true`, print the plan only |
| `--preview-only` | `-P` | `previewOnly = true`, same effect as `-n`, different wording |
| `--non-interactive` | `-y` | `nonInteractive = true` |
| `--verbose` | `-V` | `verbose = true` and sets the log level to verbose |
| `--silent` | `-s` | `silent = true` and sets the log level to error (`-V` wins) |
| `--debug` | | Sets the log level to debug |
| `--json` | | Subcommands print a machine-readable JSON document |
| `--fetch` | | Makes `status` actually contact the upstream before comparing |
| `--generate-config` | `-g` | Write a config template and exit, no sync |
| `--delete` | | `deletePolicy = 'mirror'` |
| `--renames` | | `renameDetection = true` |
| `--fetch-tags` | | `fetchConfig.tags = true` |
| `--pr` | | `prConfig.enable = true`, also reads the PR flags above |
| `--pr-draft` | | `prConfig.draft = true` |
| `--pr-no-create` | | `prConfig.create = 'never'`: push the branch, do not open a PR |
| `--undo` | `-uo` | Undo the last sync, no network involved |
| `--gray-release` | `-gr` | `grayReleaseConfig.enable = true`, also reads the gray flags above |
| `--full-release` | `-fr` | `fullRelease = true`, release the remaining gray files |
| `--rollback` | `-ro` | `rollback = true`, roll the latest gray release back |
| `--webhook-enable` | `-we` | `webhookConfig.enable = true` |
| `--log-json` | | `logConfig.json = true`, the log file becomes one JSON object per line |
| `--no-notify` | | `notifyConfig.enable = false` |
| `--no-delete` | | `deletePolicy = 'keep'` |
| `--no-renames` | | `renameDetection = false` |
| `--no-pr` | | `prConfig.enable = false` |
| `--no-fetch-tags` | | `fetchConfig.tags = false` |
| `--no-log-json` | | `logConfig.json = false`, back to the human-readable `[time] [level] text` shape |
| `--version` | `-v` | Print the version |
| `--help` | `-h` | Print help |

## Negated forms

`--no-xxx` exists so that "my config file turns this on, but not this time" is expressible. `--delete`, `--renames`, `--pr`, `--fetch-tags`, `--log-json` and `--notify` all have a positive and a negative spelling, and either one overrides the config file. None of these switches has a short alias. `--notify` is the only one whose negative form is also a declared boolean switch, so both parse results of `--no-notify` switch notifications off.

## Behaviour of each flag group

**Preview.** If either `previewOnly` or `dryRun` is true you only get a plan: no branch switch, no working-tree writes, no commit. It still creates or corrects the `sync-upstream` remote and fetches over the network, so previewing offline fails just the same.

**Gray release.** Gray flags are only written when `-gr` is present: `--percentage 30` on its own is an invalid combination. `--percentage` needs a value; a bare `--percentage` parses as `0` and triggers the "percentage must be within (0, 100]" validation error. `-fr` and `-ro` are run intents and need nothing beyond the gray configuration, but `-ro` requires that configuration to exist, otherwise the error is `--rollback also needs grayReleaseConfig to be enabled`.

**Webhook.** `-we` writes `supportedPlatforms` as the four values `github, gitlab, bitbucket, gitea` (arrays are replaced wholesale, so a list in your config file is overridden); the platform is detected per request, so GitLab works with `-we` too. To control the platform list precisely, set `webhookConfig.enable: true` and `supportedPlatforms` in the config file — the daemon starts without `-we` as well. With an empty secret every request gets `401` while the server still listens normally. `--webhook-port 0` lets the OS pick the port; combine it with `--webhook-log` and `history` when debugging deliveries.

**Fetch and LFS.** `--fetch-filter blob` (or `tree`), `--fetch-depth <n>`, `--fetch-tags/--no-fetch-tags` and `--lfs pointer|materialize|off` are each written separately, so `--fetch-depth 1` does not clear the other `fetchConfig` fields from your config file. These flags only change what is fetched from upstream, never the sync decision. `--lfs materialize` needs `git-lfs` installed locally; without it the run does not fail, the report just says the pointers were left as they are.

**Authentication.** `authConfig` is only produced when `--auth-type` is given; the other four auth fields do nothing on their own. Credentials get embedded into the remote URL: logs and error messages always redact the URL, but the `sync-upstream` remote entry in `.git/config` does contain them.

**Notifications.** `--notify slack,dingtalk` only switches the section on and names the channels; the actual addresses belong in the config file, because a chat bot URL is a credential and the command line is readable by every other process on the machine. `--notify-url` is the exception, handy for wiring one HTTP callback from CI.

**PR mode.** `--pr` commits the changes to an auto-generated branch and pushes it, leaving the target branch untouched; `--pr-no-create` only pushes the branch and never attempts to open a PR. Without a usable remote PR mode fails outright, since the branch has nowhere to go.

## Interaction and `-y`

Whether the tool asks questions is decided by one condition:

```text
interactive = !nonInteractive || config is incomplete
incomplete ⇔ upstreamRepo is empty || syncDirs is empty
```

So `-y` guarantees zero questions only when the config is complete; with `upstreamRepo` or `syncDirs` missing it still enters the completion wizard even with `-y`. The wizard asks for the missing required fields first (upstream URL, sync directories, upstream branch, target branch, commit message), then always asks five optional ones: auto-push, preview mode, retry/concurrency, conflict strategy, and finally "confirm to start syncing?". Pressing `Ctrl+C` prints the cancellation notice and exits with code `0`.

The question text is currently Chinese only; for a zero-question run, write the config file first with `init` or `--generate-config` and then pass `-y`.

## Generating a config: `--generate-config` vs `init`

```bash
sync-upstream -g                          # ./sync-upstream.config.json
sync-upstream -g -F yaml                  # ./sync-upstream.config.yaml
sync-upstream -g -C ./cfg/my.toml         # write to a chosen path, format from the extension
sync-upstream init                        # wizard, writes only what you answered
sync-upstream init -F toml -f             # toml output, allow overwriting an existing file
```

`-C` is reused as the output path in generation mode; `-F` only takes effect here and in `init` — reading a config file uses the extension instead.

The difference: `--generate-config` produces a **full template** where every field is present and commented, good for editing against this documentation; `init` is a **wizard** that writes only the handful of answered keys (repository, directories, branches, commit message, delete policy, conflict strategy, auto-push, format) and leaves everything else at its default. `init` validates the answers before touching the disk, so it cannot produce a file the next run refuses to load; an existing target needs `-f` to be overwritten. `init` requires an interactive terminal and is rejected with exit code `2` under `--json` or `-y` — in CI use `--generate-config` instead.

## Completion scripts

```bash
# bash
sync-upstream completion bash > /usr/share/bash-completion/completions/sync-upstream
# zsh (a directory on fpath, and the file must be named _sync-upstream)
sync-upstream completion zsh > "${fpath[1]}/_sync-upstream"
# fish
sync-upstream completion fish > ~/.config/fish/completions/sync-upstream.fish
```

The script is generated from the current flag table, so re-run it after an upgrade to get the new flags. After `completion` it also completes the three shell names. It completes flags and subcommands only — it will not guess your repository URL.

## Unknown flags

Any key that is not in the tables above (including short aliases and the `--no-` forms) fails the command before the sync starts:

```text
Unrecognised command-line arguments: --puuush
Run --help to see every available argument
```

Exit code `2`. This check exists so a typo cannot be silently ignored.

## Exit codes

| Code | When |
|---|---|
| `0` | Success; nothing to commit; a preview run; `--help`/`--version`/`--generate-config`/`completion`; cancelling inside a sync run, which is handled as keep-local and finishes at `0` |
| `1` | Unexpected errors; unclassified errors such as `NetworkError`/`TimeoutError`/`AuthenticationError`; at least one file failed to apply; `--undo` had nothing to revert |
| `2` | `ConfigError`/`ValidationError`; unknown command-line flags; `init` without an interactive terminal; gray release configured together with multiple upstreams |
| `3` | `GitError` (fetch, checkout, commit, push, missing ref or branch) |
| `4` | `UserCancelError`: today this is only cancelling the `sync-upstream init` questionnaire (`Ctrl+C` or choosing cancel) |
| `5` | `LockError`: the repository lock is held by another sync and `--lock-wait` did not time out in time |

The full classification is in [CI and automation](/en/guide/automation#exit-codes).

## Related pages

- [Configuration reference](/en/reference/configuration): every field's type, allowed values and aliases
- [API reference](/en/reference/api): the same capabilities as library calls
- [Usage guide](/en/guide/usage): how flags reach the config and common scenarios
