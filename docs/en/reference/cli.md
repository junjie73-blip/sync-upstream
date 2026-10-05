# CLI Reference

This page lists every `sync-upstream` command-line flag, its alias, its default value, and which configuration key it writes into. For field meanings see the [Configuration reference](/en/reference/configuration); for usage scenarios see the [Usage overview](/en/guide/usage).

## Precedence

Configuration is deep-merged from three layers, each overriding the previous one:

```text
Defaults  →  Config file  →  Command line
```

The command line only overrides the matching config when you actually pass a flag; a value you omit never erases what the file specifies. Nested objects (`retryConfig`, `conflictResolutionConfig`, `grayReleaseConfig`, `webhookConfig`) are deep-merged, while arrays (`syncDirs`, `ignorePatterns`, `includeFileTypes`) are replaced wholesale.

The command processes flags and run intent in a fixed order:

```text
1. --version        print the version, exit code 0
2. --help           print help, exit code 0
3. --generate-config generate a config file and exit (other flags are not validated)
4. unknown-flag check  any unknown flag → report an error and return exit code 2
5. read config file + merge command line + validate
6. set the log level (from the command-line -V / -s)
7. interactive completion (unless -y and the config is complete)
8. print the configuration summary
9. webhookConfig.enable → daemon mode; otherwise run the sync
```

Because the first three steps run before the unknown-flag check, `sync-upstream -g --some-nonexistent-flag` still generates the config file instead of failing.

## All flags

String flags require a value; list flags are comma-separated (they can be repeated, values are flattened and then split on commas).

| Long flag | Short | Type | Default | Config key written |
|---|---|---|---|---|
| `--repo` | `-r` | string | `''` | `upstreamRepo` |
| `--branch` | `-b` | string | `main` | `upstreamBranch` |
| `--company-branch` | `-c` | string | `main` | `companyBranch` |
| `--dirs` | `-d` | list | `[]` | `syncDirs` |
| `--message` | `-m` | string | `Sync upstream changes to specified directories` | `commitMessage` |
| `--config` | `-C` | string | auto-discovered | sets the config file path; a read failure raises an error immediately |
| `--config-format` | `-F` | string | `json` | only affects the output format of `--generate-config` |
| `--ignore` | | list | `[]` | `ignorePatterns` (appended, gitignore syntax) |
| `--include-types` | | list | `[]` | `includeFileTypes` (e.g. `.ts,.vue`) |
| `--concurrency` | | string→number | `10` | `concurrencyLimit` |
| `--retry-max` | | string→number | `3` | `retryConfig.maxRetries` |
| `--retry-delay` | | string→number | `2000` | `retryConfig.initialDelay` |
| `--retry-backoff` | | string→number | `1.5` | `retryConfig.backoffFactor` |
| `--conflict-strategy` | | string | `prompt-user` | `conflictResolutionConfig.defaultStrategy` |
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
| `--webhook-port` | | string→number | `3000` | `webhookConfig.port` |
| `--webhook-path` | | string | `/webhook` | `webhookConfig.path` |
| `--webhook-secret` | | string | `''` | `webhookConfig.secret` |
| `--webhook-events` | | list | `push` | `webhookConfig.allowedEvents` |
| `--webhook-branch` | | string | `main` | `webhookConfig.triggerBranch` |

Boolean flags default to `false` when not given; there is no `--no-xxx` form:

| Long flag | Short | Effect |
|---|---|---|
| `--push` | `-p` | `autoPush = true` (cannot be forced back to `false` from the command line) |
| `--force` | `-f` | `forceOverwrite = true` |
| `--incremental` | | `forceOverwrite = false`; when given together with `-f`, this one wins |
| `--dry-run` | `-n` | `dryRun = true`, prints only the plan |
| `--preview-only` | `-P` | `previewOnly = true`, same effect as `-n` but a different prompt wording |
| `--non-interactive` | `-y` | `nonInteractive = true` |
| `--verbose` | `-V` | `verbose = true` and sets the log level to verbose |
| `--silent` | `-s` | `silent = true` and sets the log level to error (`-V` takes priority) |
| `--generate-config` | `-g` | generates a config file and exits, no sync run |
| `--gray-release` | `-gr` | `grayReleaseConfig.enable = true`, and reads the gray-release flags from the table above |
| `--full-release` | `-fr` | `fullRelease = true`, releases the remaining gray-release files |
| `--rollback` | `-ro` | `rollback = true`, rolls back the most recent gray release |
| `--webhook-enable` | `-we` | `webhookConfig.enable = true` |
| `--version` | `-v` | print the version |
| `--help` | `-h` | print help |

## Flag group behaviour

**Preview.** If either `previewOnly` or `dryRun` is true, only the plan is produced: no branch switch, no working-tree writes, no commit. It still adds or corrects the `sync-upstream` remote and pulls upstream over the network, so a preview fails offline just like a real run.

**Gray release.** Gray-release-related flags are only written to the config when `-gr` is present: passing `--percentage 30` on its own, without `-gr`, is an ineffective combination. `--percentage` must carry a value; a bare `--percentage` with an empty value parses to `0` and triggers the validation error `percentage 必须在 (0, 100] 内` ("percentage must be within (0, 100]"). `-fr` and `-ro` are run-intent switches that need no precondition beyond `-gr`, but `-ro` requires a gray-release config to exist, otherwise it reports `--rollback 需要同时启用 grayReleaseConfig` ("--rollback requires grayReleaseConfig to be enabled as well").

**Webhook.** `-we` pins `supportedPlatforms` to `['github']` (arrays are replaced wholesale, so the platform list in the config file is overridden by it). To handle GitLab/Gitea/Bitbucket, write `webhookConfig.enable: true` and `supportedPlatforms` in the config file; without `-we` it still enters daemon mode. When the secret is empty, every request returns `401`, though the server still listens normally.

**Authentication.** `authConfig` is only built when `--auth-type` is given; the other four auth fields have no effect on their own. Credentials are embedded into the remote URL; URLs in logs and error messages are always redacted, but the URL of the `sync-upstream` remote in `.git/config` does contain the credentials.

## Interactive prompts

Whether the tool asks is decided by a single condition:

```text
interactive = !nonInteractive || config incomplete
config incomplete ⇔ upstreamRepo is empty || syncDirs is empty
```

So `-y` guarantees zero prompts only when the config is complete; if `upstreamRepo` or `syncDirs` is missing, it still enters the completion questionnaire even with `-y`. Completion first asks for the missing required fields (upstream URL, sync directories, upstream branch, target branch, commit message), then always asks five optional ones: auto-push, preview mode, retry concurrency on failure, conflict resolution method, and finally a "confirm to start syncing?" prompt. Pressing `Ctrl+C` to cancel prints `操作已取消` ("Operation cancelled") and exits with code `0`.

## Unknown flags

Any key not in the tables above (including the short aliases) makes the command fail before the sync starts:

```text
无法识别的命令行参数: --puuush
使用 --help 查看全部可用参数
```

The two lines above are the tool's actual output: the first reports the unrecognised argument `--puuush`, the second tells you to use `--help` to list all available flags. It returns exit code `2`. This check exists to avoid the "typo in a flag but it was silently ignored" situation.

## Exit codes

| Code | Trigger |
|---|---|
| `0` | success; nothing to commit; a preview run; `--help`/`--version`/`--generate-config`; interactive cancel |
| `1` | unexpected errors; non-categorised errors such as `NetworkError`/`TimeoutError`/`AuthenticationError`; some files failed to apply in this run |
| `2` | `ConfigError`/`ValidationError`; unknown command-line flags |
| `3` | `GitError` (fetch, checkout, commit, push, missing ref or branch) |
| `4` | reserved code for `UserCancelError`: the current cancel path exits directly with `0`, so scripts never observe 4 |

The full categorisation is in [CI and automation](/en/guide/automation#exit-codes).

## Generating a config file

```bash
sync-upstream -g                          # ./sync-upstream.config.json
sync-upstream -g -F yaml                  # ./sync-upstream.config.yaml
sync-upstream -g -C ./cfg/my.toml         # write to a given path, format inferred from the extension
```

In generate mode, `-C` is reused as the output path; `-F` only applies here, while reading config uses the file extension to detect the format.

## Related pages

- [Configuration reference](/en/reference/configuration): each field's type, allowed values, and aliases
- [API reference](/en/reference/api): the library entry points for the same capabilities
- [Usage overview](/en/guide/usage): how flags feed the config and common usage scenarios
