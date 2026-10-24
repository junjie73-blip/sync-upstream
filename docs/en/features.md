# Features

Only features that are **actually usable** in the current version are listed here, each with how you use it and where its behaviour stops. Design rationale and internal implementation are not on this page — this is a user guide, not contributor documentation.

## Sync core

### Directory-scoped sync
- **What it does**: syncs only the paths listed in `syncDirs`; files outside the scope are never read, modified, or committed
- **How you use it**: `syncDirs` or `-d a,b`; an entry may be a directory or **the path of a single file**
- **Watch out**: a sync scope matches on "path equals the entry or lies beneath it", so `packages/shared` does not match `packages/shared-utils`
- **Docs**: [Everyday sync](/en/guide/sync-basics) · [Single files and partial scopes](/en/guide/automation#single-files-and-partial-scopes)

### The preview is the result
- **What it does**: lists every path that will be added / modified / deleted in this run before anything is executed, and the preview list matches the commit content exactly
- **How you use it**: `-P` (or `-n` in scripts), add `-V` to print the complete list
- **Watch out**: a preview still fetches upstream and updates the `sync-upstream` remote, so it fails when offline
- **Docs**: [Preview before you change anything](/en/guide/sync-basics#preview-before-you-change-anything)

### Incremental sync
- **What it does**: content already synced last time is skipped automatically, and only files that changed afterwards are processed
- **How you use it**: `--incremental` (or `forceOverwrite: false`); `--force` ignores the baseline and re-compares everything
- **Watch out**: the baseline lives in `.sync-state.json`, is invalidated and rebuilt automatically when the upstream repository or branch changes; deleting it corrupts nothing, but the incremental baseline, the `history` records and the reference `--undo` needs all disappear with it, so the next run compares everything
- **Docs**: [Full vs incremental](/en/guide/sync-basics#full-vs-incremental) · [Runtime files and cleanup](/en/reference/configuration#runtime-files-and-cleanup)

### Batch apply, contained failures
- **What it does**: applies changes in batches when there are many files; a failing file is marked on its own with the reason kept, and the rest still complete
- **How you use it**: `concurrencyLimit` / `--concurrency`
- **Watch out**: when failing files exist the exit code is 1; fix the cause and rerun — the parts that already succeeded are not processed twice
- **Docs**: [Concurrency and retries](/en/guide/automation#concurrency-and-retries)

### Ignore rules
- **What it does**: excludes files using gitignore semantics, supporting `!` negation, `/` anchoring, and `**` across directories
- **How you use it**: `ignorePatterns` / `--ignore`, plus the extension allow-list `includeFileTypes` / `--include-types`
- **Watch out**: the stacking order is built-in rules → root `.gitignore` → `.syncignore` → config entries → nested `.gitignore` inside the sync scope directories, and later sources win
- **Docs**: [Where ignore rules live](/en/guide/configuration#where-ignore-rules-live)

### One sync per repository
- **What it does**: only one real sync may run against a repository at a time, so two processes stepping on each other goes from "lucky it did not happen" to a guarantee
- **How you use it**: nothing to enable; when another process holds it, wait with `--lock-wait 30000`, and the default `0` means fail immediately
- **Watch out**: the lock lives in `.git/sync-upstream.lock`; it is taken over automatically when the holder has exited or timed out, so no stale lock is left for a human to clean up; `doctor` tells you who holds it
- **Docs**: [Concurrency and retries](/en/guide/automation#concurrency-and-retries) · [Runtime files and cleanup](/en/reference/configuration#runtime-files-and-cleanup)

### Multiple upstreams and any ref
- **What it does**: one run merges several upstreams in order (fan-in), and a source may be a tag or a commit, not only a branch
- **How you use it**: write `upstreams: [{ repo, ref }]` in the configuration, or repeat `-r A -r B -b main -b v1.8.0` on the command line, paired by position
- **Watch out**: each upstream has its own state file and its own dedicated remote, so two upstreams never mark each other's changes as already synced; gray release, `--rollback`, and `--full-release` are not supported in multi-upstream mode and are rejected outright instead of silently ignored
- **Docs**: [Multiple upstreams](/en/guide/sync-basics)

### Rename detection
- **What it does**: when upstream renames a file, the sync records a rename instead of a delete plus an add, so history and review diffs stay shorter
- **How you use it**: on by default (`renameDetection: true`); `--no-renames` turns it off, `--rename-threshold 80` raises the similarity bar (default 60)
- **Watch out**: below the bar the change is still handled as delete plus add; rename detection never changes the resulting content, only how the change list is presented
- **Docs**: [Renames and deletions](/en/guide/sync-basics)

### What happens when upstream deletes
- **What it does**: for files upstream deleted you can delete them too, keep them locally, or be asked every time
- **How you use it**: `deletePolicy: mirror | keep | ask`, on the command line `--delete-policy`, `--delete`, `--no-delete`
- **Watch out**: `ask` needs an interactive terminal; without one it behaves as keep-local; the preview lists the files deleted upstream but kept, so you can clean them up separately afterwards
- **Docs**: [Deletion policy](/en/guide/sync-basics)

### Fetching large repositories and Git LFS
- **What it does**: fetches only the objects you need (partial clone), caps how much history is taken, and recognises Git LFS pointers
- **How you use it**: `--fetch-filter blob` (or `tree`), `--fetch-depth 50`, `--fetch-tags` / `--no-fetch-tags`, `--lfs pointer | materialize | off` (default `pointer`)
- **Watch out**: these switches only change what is fetched from upstream, never the sync decision; `--lfs materialize` needs `git-lfs` installed on the machine — when it is not, nothing fails, the report just says the pointers were kept as they are
- **Docs**: [Fetching large repositories](/en/guide/sync-basics)

## Look before you leap, undo after you act

### Four read-only subcommands
- **What it does**: answers "what is the state right now / why was this file not synced / what is wrong with the environment / what was synced recently" without touching the working tree
- **How you use it**: `sync-upstream status [--fetch]`, `sync-upstream why <path in the repository>`, `sync-upstream doctor`, `sync-upstream history [--limit <n>]`
- **Watch out**: `status` stays offline by default and only really compares against upstream with `--fetch`; `history` reads the record every real sync leaves behind and shows 10 entries by default; all four take `--json`, and stdout then holds that single JSON document only
- **Docs**: [The four read-only subcommands](/en/guide/usage#the-four-read-only-subcommands) · [CLI reference → Subcommands](/en/reference/cli#subcommands)

### Undo the last sync
- **What it does**: reverses the apply of the previous real sync as a whole
- **How you use it**: `sync-upstream --undo` (`-uo`)
- **Watch out**: it makes no network calls and accepts no sync parameters; the undo is itself recorded in history, and `--json` works the same way
- **Docs**: [Undo the last sync](/en/guide/sync-basics#undo-the-last-sync)

## Conflict handling

### Conflict detection
- **What it does**: automatically marks files changed on both the local side and upstream, in 4 kinds: `content` (both sides edited), `delete-modify` (one side deletes, the other edits), `untracked-overwrite` (an untracked local file would be overwritten), `type` (a file and a directory share the name)
- **How you use it**: nothing to enable; the `冲突: N 个文件` line in the plan output ("Conflicts: N files") is exactly them
- **Watch out**: only a real run has to make the resolving decisions; a preview only reports
- **Docs**: [Which conflicts are detected](/en/guide/conflicts#which-conflicts-are-detected)

### The five strategies
- **What it does**: handles conflicts by policy: `use-source` takes upstream, `keep-target` keeps local, `auto-merge` attempts a merge, `prompt-user` asks file by file, `skip` skips
- **How you use it**: `--conflict-strategy <s>` or `conflictResolutionConfig.defaultStrategy`; an invalid strategy value fails validation outright instead of silently falling back to the default
- **Watch out**: with `-y` and the `prompt-user` strategy, conflicts are resolved as keep-local automatically and a warning is raised
- **Docs**: [The five strategies](/en/guide/conflicts#the-five-strategies) · [Behaviour without a terminal](/en/guide/conflicts#behaviour-without-a-terminal)

### Three-way merge
- **What it does**: `auto-merge` tries to merge both sides' line-level changes automatically; when it cannot, it writes `<<<<<<< LOCAL` / `=======` / `>>>>>>> UPSTREAM` markers into the file for you to handle
- **How you use it**: `--conflict-strategy auto-merge`
- **Watch out**: files above roughly 20,000 lines are not auto-merged (it would be slow and produce meaningless results) — both sides are kept for manual handling instead; binary files are never attempted
- **Docs**: [How auto-merge works](/en/guide/conflicts#how-auto-merge-works)

### Silencing prompts by extension
- **What it does**: skips prompting for the given extensions under `prompt-user`
- **How you use it**: `conflictResolutionConfig.autoResolveTypes: [".md"]`
- **Watch out**: silencing means **keep local**, not auto-merge; for automatic merging set `defaultStrategy` to `auto-merge`
- **Docs**: [Silencing prompts by extension](/en/guide/conflicts#silencing-prompts-by-extension)

## Release control

### Gray release
- **What it does**: releases a small subset of files first, validates it, then fills in the rest
- **How you use it**: `-gr` to enable, `--strategy percentage|directory|file` to choose how, `--percentage 20` / `--canary-dirs` / `--file-patterns` to set the amount
- **Watch out**: the selection for a given batch is deterministic — rerunning the same percentage gives the same batch; an empty selection is an immediate error
- **Docs**: [Gray release and rollback](/en/guide/gray-release)

### Release validation
- **What it does**: after the canary release it runs your own validation command, and a non-zero exit counts as validation failure
- **How you use it**: `--validation-script "pnpm test"`; tune the timeout and retry count via `grayReleaseConfig`
- **Watch out**: a single validation command is force-killed after at most 120 seconds; only the first 4000 characters of output are kept; on validation failure **nothing rolls back automatically** unless you set `rollbackOnFailure: true`
- **Docs**: [Configuration example](/en/guide/gray-release#configuration-example)

### Full release and rollback
- **What it does**: `-fr` releases the remaining files; `-ro` puts what was already released back to the pre-release state
- **How you use it**: `-gr --full-release` / `-gr --rollback` (rollback needs `-gr` too, because it depends on the gray release progress record)
- **Watch out**: rollback **adds one new rollback commit**, it is not `git reset`, so pushed history is not rewritten; do not delete `.sync-gray.json` while a gray release is in progress
- **Docs**: [What rollback actually does](/en/guide/gray-release#what-rollback-actually-does) · [Runtime files and cleanup](/en/reference/configuration#runtime-files-and-cleanup)

### GitOps: changes go through a PR, not straight onto the branch
- **What it does**: commits this sync onto an automatically generated branch and pushes it, leaving the target branch untouched so a review decides whether it merges
- **How you use it**: `--pr` (or `prConfig.enable: true`), configured with `--pr-branch` / `--pr-remote` / `--pr-title` / `--pr-body` / `--pr-draft` / `--pr-no-create`
- **Watch out**: `--pr-no-create` only pushes the branch and never tries to open a PR; a PR is attempted only when a CLI such as `gh` / `glab` is installed on the machine and the remote can be recognised, and when it is not available you are simply given a link — the sync does not fail; with no pushable remote it errors out immediately
- **Docs**: [PR mode](/en/guide/sync-basics) · [Behaviour of each flag group](/en/reference/cli#behaviour-of-each-flag-group)

## Triggers and integration

### Authentication
- **What it does**: read access to private repositories, in three ways: `ssh` / `pat` / `user_pass`
- **How you use it**: `--auth-type` plus the matching credential flags, or write `authConfig`; without `--auth-type` the other authentication fields have no effect
- **Watch out**: URLs in logs and errors are always redacted; `pat` / `user_pass` write the credential into the remote URL in `.git/config`, so do not paste that file anywhere
- **Docs**: [Authenticating to private repositories](/en/guide/quick-start#authenticating-to-private-repositories) · [Behaviour of each flag group](/en/reference/cli#behaviour-of-each-flag-group)

### Branch strategy
- **What it does**: completes the sync on a derived branch so it can be reviewed before merging back
- **How you use it**: `branchStrategyConfig.enable: true`, `strategy` one of `feature` / `release` / `hotfix` / `develop`, `branchPattern` defaults to `feature/sync-{date}` (supports `{date}`, `{base}`, `{strategy}`)
- **Watch out**: only takes effect in a real run — a preview switches no branch; a missing base branch is an immediate error; `autoSwitchBack` (on by default) returns you to the branch you were on once the commit is done, and `autoDeleteMergedBranches` (off by default) removes only sync branches this tool generated, already merged into the target and not currently checked out — `git branch -d` refuses anything unmerged, so it cannot delete your work
- **Docs**: [Branch strategy](/en/guide/sync-basics#branch-strategy)

### Webhook daemon
- **What it does**: stays resident, receives upstream events, and triggers one sync when the conditions match
- **How you use it**: `-we`, configured with `--webhook-port` / `--webhook-path` / `--webhook-secret` / `--webhook-events` / `--webhook-branch`, and for operations `--webhook-host` / `--webhook-log` / `--webhook-queue`
- **Watch out**: supports GitHub / GitLab / Bitbucket / Gitea, with the platform recognised per request; when the secret is empty every request is rejected (401); the request body is capped at 1 MiB (tunable through `maxBodyBytes`); it answers first and syncs in the background, so a background failure is only logged and never reported back to upstream; it binds `127.0.0.1` by default, so outside access means changing `host` explicitly; `port: 0` lets the system assign the port; `GET /healthz` is the liveness probe (renamable, and it can be switched off); the same event is deduplicated by default and each delivery decision is written to `deliveryLog`; when concurrent deliveries exceed `maxQueue` (default 8) it answers 503 so the platform re-delivers later; without `trustProxy` the `x-forwarded-for` header is not consulted
- **Docs**: [Webhook daemon](/en/guide/webhook) · [Request handling order](/en/guide/webhook#request-handling-order)

### Notification hooks
- **What it does**: after a sync finishes it pushes the result to an HTTP callback, Slack, DingTalk, WeCom, or straight to stdout
- **How you use it**: `notifyConfig` picks the channels and the events; on the command line `--notify slack,dingtalk` / `--notify-url` / `--notify-events` / `--no-notify`
- **Watch out**: the bot's real address belongs in the configuration file, not the command line (the command line is visible to every other process on the machine); a failed notification never changes the sync result or the exit code, it only leaves one line in the log; the default events are success, conflict, failure, and undo
- **Docs**: [Notification hooks](/en/guide/automation) · [Configuration reference](/en/reference/configuration)

### Retries
- **What it does**: retries upstream fetches that failed from network flapping with backoff; other errors are thrown immediately
- **How you use it**: `retryConfig` / `--retry-max` `--retry-delay` `--retry-backoff`
- **Watch out**: retries apply to the upstream fetch step only; failures during apply and commit are not retried (rerun the whole command)
- **Docs**: [Concurrency and retries](/en/guide/automation#concurrency-and-retries)

### Logging and exit codes
- **What it does**: levelled logging, rotatable log files on disk, machine-readable output, and exit codes you can branch on
- **How you use it**: `-V` for more detail, `-s` to keep errors only, `--debug` for the lowest-level debug output; `--log-file runs/sync.log` writes to disk, with `--log-level` / `--log-max` (default 5 MiB) / `--log-keep` (default 5 files) / `--log-json` controlling the content; `--json` makes the read-only subcommands output a single JSON document; `0` success (including no changes and preview), `1` some files failed, `2` configuration or argument problem, `3` git operation failed, `4` you cancelled the `init` questionnaire, `5` the repository is held by another sync
- **Watch out**: pressing `Ctrl+C` during a sync is not a failure — it is treated as keep-local and the run still finishes at `0`, so `4` only comes from `init`; log files roll by size, and deleting the old ones affects no feature
- **Docs**: [Logging](/en/guide/automation#logging) · [Exit codes](/en/guide/automation#exit-codes) · [Logging and errors](/en/reference/api#logging-and-errors)

## Getting started and terminal experience

### Guided init
- **What it does**: answers a few questions and gives you a usable configuration file, writing only the fields you answered
- **How you use it**: `sync-upstream init`, `-F yaml|toml|json5|json` for the format, `-C` for the path, `-f` to allow overwriting
- **Watch out**: the answers are validated before anything is written, so it cannot produce a file the next run refuses to load; an existing target file requires `-f`; it needs an interactive terminal — with `--json`, with `-y`, or in CI it is refused (exit code 2), and those runs should use `--generate-config` instead
- **Docs**: [Generating a config](/en/reference/cli#generating-a-config-generate-config-vs-init) · [Quick start](/en/guide/quick-start)

### Bilingual output
- **What it does**: help text, flag errors, and runtime errors are given per language; Chinese and English are two renderings of the same wording
- **How you use it**: `--lang zh|en` to switch for one run, `SYNC_UPSTREAM_LANG` to pin it for this tool only, otherwise `LC_ALL` / `LANG` / `LANGUAGE` are read
- **Watch out**: the decision order is `SYNC_UPSTREAM_LANG` > `LC_ALL` > `LANG` > `LANGUAGE`; `zh*` means Chinese, any other recognised locale means English, and when none of them is set, or only `C` / `POSIX` is, it uses the Chinese default — the tool never looks for the system locale anywhere else, so a container without a locale has to ask for English explicitly; `--lang` only changes the output language and is never written into the configuration; a wrong value is explained in the language you were already getting
- **Docs**: [Language (`--lang`)](/en/reference/cli#language-lang)

### Shell completion
- **What it does**: subcommands, flags, and shell names are completable in bash / zsh / fish
- **How you use it**: `sync-upstream completion bash|zsh|fish`, redirected into the matching completion directory
- **Watch out**: the script is generated from the current flag table, so regenerate it once after an upgrade to get the new flags; it does not guess repository URLs, and it completes nothing beyond the flags, subcommands, and file paths the tool itself takes
- **Docs**: [Completion scripts](/en/reference/cli#completion-scripts) · [Installation](/en/guide/installation)

## Not supported (so you are not surprised)

- It does not rewrite your `origin`; it only maintains a dedicated remote named `sync-upstream` (in multi-upstream mode a second remote such as `sync-upstream-2`)
- It does not sync submodule pointers
- It does not preserve upstream commit history: it syncs content, not commits
- Multi-upstream (`upstreams`) does not support gray release, `--rollback`, or `--full-release`; those are rejected explicitly rather than silently ignored — for a gray release configure one upstream at a time
- It does not manage the Git LFS object store: it only recognises the pointer files and, according to `--lfs`, keeps them as they are, calls your local `git-lfs` to fetch the real content, or ignores them completely
- No scheduled jobs, no visual dashboard, no licence scanning, no permission management, no multi-environment configuration, no automatic conflict suggestions
- Notifications go to an HTTP callback / Slack / DingTalk / WeCom / stdout only; no email
- The environment variables it reads are a short closed list: `SYNC_UPSTREAM_LANG`, `LC_ALL`, `LANG`, and `LANGUAGE` for deciding the output language, `GITHUB_STEP_SUMMARY` for writing the summary onto the GitHub Actions run page, and `SYNC_UPSTREAM_PR_CREATE=0` to skip creating the pull request. Repository credentials are still never read from the environment, only from the configuration file and the command line
- What `--lang en` covers is the help text, flag errors, error messages, and the `init` questionnaire. The completion questions, conflict prompts and delete confirmation inside a sync, the configuration summary, the run logs, and the bodies of `status` / `doctor` / `why` / `history` are Chinese-only for now (use `--json` when you need machine-readable content)

## Related pages

- [Usage overview](/en/guide/usage): find the docs by task
- [FAQ](/en/faq): errors and questions about behaviour
- [Changelog](/en/changelog): changes between versions
- [Planned for the next release](/en/roadmap): when the limits above are expected to go
