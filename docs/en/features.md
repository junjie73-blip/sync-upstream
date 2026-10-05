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
- **Watch out**: the baseline lives in `.sync-state.json`, is invalidated and rebuilt automatically when the upstream repository or branch changes, and is safe to delete
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

## Triggers and integration

### Authentication
- **What it does**: read access to private repositories, in three ways: `ssh` / `pat` / `user_pass`
- **How you use it**: `--auth-type` plus the matching credential flags, or write `authConfig`; without `--auth-type` the other authentication fields have no effect
- **Watch out**: URLs in logs and errors are always redacted; `pat` / `user_pass` write the credential into the remote URL in `.git/config`, so do not paste that file anywhere
- **Docs**: [Authenticating to private repositories](/en/guide/quick-start#authenticating-to-private-repositories) · [Flag group behaviour](/en/reference/cli#flag-group-behaviour)

### Branch strategy
- **What it does**: completes the sync on a derived branch so it can be reviewed before merging back
- **How you use it**: `branchStrategyConfig.enable: true`, `strategy` one of `feature` / `release` / `hotfix` / `develop`, `branchPattern` defaults to `feature/sync-{date}` (supports `{date}`, `{base}`, `{strategy}`)
- **Watch out**: only takes effect in a real run — a preview switches no branch; a missing base branch is an immediate error; `autoSwitchBack` and `autoDeleteMergedBranches` are reserved fields with **no behaviour in the current version**
- **Docs**: [Branch strategy](/en/guide/sync-basics#branch-strategy)

### Webhook daemon
- **What it does**: stays resident, receives upstream events, and triggers one sync when the conditions match
- **How you use it**: `-we`, configured with `--webhook-port` / `--webhook-path` / `--webhook-secret` / `--webhook-events` / `--webhook-branch`
- **Watch out**: supports GitHub / GitLab / Bitbucket / Gitea; when the secret is empty every request is rejected (401); the request body is capped at 1 MiB; it answers first and syncs in the background, so a background failure is only logged and never reported back to upstream
- **Docs**: [Webhook daemon](/en/guide/webhook) · [Request handling order](/en/guide/webhook#request-handling-order)

### Retries
- **What it does**: retries upstream fetches that failed from network flapping with backoff; other errors are thrown immediately
- **How you use it**: `retryConfig` / `--retry-max` `--retry-delay` `--retry-backoff`
- **Watch out**: retries apply to the upstream fetch step only; failures during apply and commit are not retried (rerun the whole command)
- **Docs**: [Concurrency and retries](/en/guide/automation#concurrency-and-retries)

### Logging and exit codes
- **What it does**: levelled logging and routable exit codes, so scripts can branch on them
- **How you use it**: `-V` for more detail, `-s` to keep errors only; `0` success (including no changes and preview), `1` some files failed, `2` configuration or argument problem, `3` git operation failed
- **Watch out**: `-V` does not turn on the lowest-level debug logging; exit code `4` is reserved and cannot be produced today
- **Docs**: [Logging](/en/guide/automation#logging) · [Exit codes](/en/guide/automation#exit-codes) · [Logging and errors](/en/reference/api#logging-and-errors)

## Not supported

- It does not rewrite your `origin`; it only maintains a dedicated remote named `sync-upstream`
- It does not sync submodule pointers
- It does not preserve upstream commit history: it syncs content, not commits
- No dedicated Git LFS handling, no scheduled jobs, no visual dashboard
- It reads no environment variables: configuration and credentials may come only from the config file and the command line
- Not implemented: multiple upstream repositories, email/IM notifications, an HTTP API, automatic conflict suggestions, licence scanning, permission management, multi-environment configuration

## Related pages

- [Usage overview](/en/guide/usage): find the docs by task
- [FAQ](/en/faq): errors and questions about behaviour
- [Changelog](/en/changelog): changes between versions
