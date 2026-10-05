# Frequently asked questions

## Basics

### What is the difference between sync-upstream and `git merge upstream/main`?

`git merge` merges the whole branch, and merge itself decides how conflicts are handled and what the commit looks like. The boundary of sync-upstream is the **directory**: it only compares, only writes, and only commits the paths inside `syncDirs`; nothing outside those directories is touched. When you want to follow only a few upstream packages while keeping your local customisations, it is far more controllable than merge; when you genuinely want a full branch merge, use merge — it is more direct.

### What is the difference compared to copy-pasting folders?

Copy-paste has no idea "which files changed" and leaves no record you can roll back. This tool derives the exact change set from git, so the preview result, the commit content, and `.sync-state.json` always agree; gray release additionally keeps a baseline commit that `--rollback` can use.

### How is this more convenient than the built-in fork sync on GitHub / Gitee?

The downside first: **if you only occasionally need your fork's default branch to catch up with upstream, the built-in "Fetch upstream" / branch sync is easier** (one click, zero configuration) — this tool does not try to replace that.

What it does instead are the things fork sync cannot do:

| Scenario | Built-in fork sync | This tool |
|---|---|---|
| Follow only a few upstream directories (or one file) | Not possible, it merges the whole branch | `syncDirs` bounds the scope; outside it nothing is read, written, or committed |
| Keep local customisations in other directories | Customised directories go into the merge too; conflicts are yours to resolve by hand | Customised directories do not participate at all; conflicted files can keep local or be three-way merged per strategy |
| Confirm "which files did this run actually change" | Read the diff of the merge commit | Every `+`/`~`/`-` printed by the preview is a path carried by the commit |
| Ship a large change in batches | All or nothing | `-gr` releases 20% first, `-fr` completes it after validation, and `-ro` reverts only the batch that was released |
| A non-default branch / several branches | Usually the default branch only; on Gitee it is unavailable when you have local-only commits | `-c` targets any branch, and a branch strategy can land the work on `feature/sync-{date}` |
| Resulting history shape | A merge commit (upstream history and merge relationship preserved) | A single sync commit (it syncs content, not history) |

Do not use it when you need to preserve upstream commit history, need rebase / linear history, want upstream changes opened as a PR for review, or just want one-click fork updates.

The full comparison with concrete examples is in [Compared to fork syncing](/en/guide/vs-fork-sync).

### Which git / node versions are supported?

Node ≥ 18.2, Git ≥ 2.25. The tool calls your local `git` directly, so your proxy, `insteadOf`, and credential-helper configuration keeps working as usual.

## Configuration

### Why did my configuration file not take effect?

You now get an explicit error instead of a silent fallback: if the file given to `-C` does not exist (`配置文件不存在: <path>` — "config file not found"), is unreadable, has a syntax error, is empty, or has a non-object top level, the run aborts with the reason; a parse failure also lists the JSON / YAML / TOML errors separately. Without `-C`, 16 candidate file names are searched in a fixed order, and if none is found you get a warning that spells out the search scope.

### I wrote fields like `targetBranch` / `maxRetries` — does the tool understand them?

Yes, they are historical aliases and are rewritten automatically to `companyBranch` / `retryConfig.maxRetries` with a one-time warning. If an alias has the wrong value type it is a hard error (for example `maxRetries: "abc"`). To avoid aliases entirely, write the canonical keys as documented in the [configuration reference](/en/reference/configuration).

### Why do I see `未识别的配置项 xxx 已忽略` ("unrecognized configuration option xxx ignored")?

That key belongs to neither a canonical field nor an alias, so it is most likely a typo. The tool refuses to let it fail silently, hence the explicit warning.

### Why do I only see the first configuration error?

It is not only one — validation collects every problem and prints them at once (listed line by line after `配置校验失败:` — "configuration validation failed:"). After you fix them, the next run may reveal the remaining problems, but those belong to a later stage.

### Where did the cache / LFS options go?

The cache layer and the LFS-specific configuration were removed in the rewrite: sync decisions come straight from git's comparison, so caching brings no benefit any more, and large files are transferred by git itself — LFS only needs `.gitattributes` in the repository. Writing keys such as `cacheConfig` now only produces a deprecation warning.

## Usage

### How do I confirm which files it will change before letting it act?

```bash
sync-upstream -P -V    # preview + full change list
```

Preview does not switch branches, does not touch the working tree, and creates no commit; every `+` / `~` / `-` it prints is a path that would appear in the commit. The single exception is that it still adds or corrects the remote named `sync-upstream` and fetches over the network (which is written into `.git/config`), so preview also fails when you are completely offline. Details in [Daily sync — preview before you change anything](/en/guide/sync-basics#preview-before-you-change-anything).

### Too many interactive prompts — how do I skip them in CI?

```bash
sync-upstream -y -C sync-upstream.config.json
```

**`-y` only guarantees zero prompts when the configuration is complete**: the condition is `!nonInteractive || configuration is incomplete`, and "incomplete" means `upstreamRepo` is empty or `syncDirs` is empty — with either missing, the completion questionnaire runs even with `-y`. Also, under `-y` the `prompt-user` conflict strategy is automatically downgraded to "keep local" with a warning, so in CI you should state `--conflict-strategy` explicitly. See [Running in CI](/en/guide/automation#running-in-ci).

### The plan shows changes, but the result says nothing was committed

Two cases:

- The plan is empty → `没有需要同步的变更，无需提交` ("there is nothing to sync, no commit needed")
- The plan is non-empty but the staging area has no diff (the content already matches the target branch) → `计划中的 N 项变更未产生暂存差异，目标分支已与上游一致` ("the N planned changes produced no staged diff; the target branch already matches upstream")

The second one is not an error; it happens when you sync the same content twice.

### Upstream changed 100 files but I only synced 90

Look at the skipped-summary line at the end of the plan (`跳过 … 条`, "skipped … entries"): `被忽略规则排除` (excluded by an ignore rule), `文件类型不在白名单` (file type not in the allow list), `已是最新` (already up to date — incremental mode), `不在同步目录内` (outside the sync directories). Submodule pointers do not participate in syncing either. To find out why a particular file is ignored, check the root `.gitignore`, `.syncignore`, and any nested `.gitignore` inside the sync directories.

### Upstream moved a file — will the old path stay behind?

No. When upstream moves a file (a rename with unchanged content), both the deleted old path and the added new path are recorded in the same commit, so no stale path is left behind.

### Can I delete `.sync-state.json`?

Yes — it is equivalent to a disposable incremental cache; after deleting it, the next full comparison is enough. You can also just run `--force` and ignore it. When you switch upstream repository or upstream branch, the file is rebuilt automatically. For its location and cleanup advice see [Runtime files and cleanup](/en/reference/configuration#runtime-files-and-cleanup).

### How do I sync only some files inside a directory?

`syncDirs` sets the scope, `includeFileTypes` sets the extension allow list, and `ignorePatterns` / `.syncignore` handle exclusions. **Syncing a single file** needs no special pattern: a sync directory matches both directories and a file of the same name, so just write the file path into `syncDirs` (`"syncDirs": ["package.json"]`). Arbitrary path remapping (sync upstream path A into local path B) is not supported yet. See [Single files and partial scopes](/en/guide/automation#single-files-and-partial-scopes).

### Will it commit my uncommitted changes along the way?

No. The commit contains only the paths this sync actually applied. If there are uncommitted local changes inside a sync directory, they are listed as local changes and may be classified as conflicts, but they are never committed as a side effect.

## Conflicts

### Which strategies are there?

`use-source` (take upstream), `keep-target` (keep local), `auto-merge` (three-way merge), `prompt-user` (ask per file, the default), `skip` (skip). On the CLI use `--conflict-strategy`; in a configuration file it is `conflictResolutionConfig.defaultStrategy`. Conflict detection currently produces 4 real categories: content conflict, upstream deletion with local modifications, needing to overwrite an untracked file, and file type change — see [Which conflicts are detected](/en/guide/conflicts#which-conflicts-are-detected).

### What happens when `auto-merge` cannot merge?

- Both sides changed and the line ranges overlap: standard conflict markers (`<<<<<<< LOCAL` / `=======` / `>>>>>>> UPSTREAM`) are written and the file is staged — you have to finish the resolution by hand
- Binary (contains NUL bytes): marked as skipped, no line-level merge is attempted
- Deletion on one side + modification on the other: classified as a conflict and handed back to you
- Files over 20 000 lines: no line-by-line merge; conflict markers are emitted for the whole file instead

### What is `autoResolveTypes` for?

Under `prompt-user`, matching extensions **produce no prompt** and are handled by the conservative "keep local" choice. It does not mean "auto-merge these extensions" — for that you set `defaultStrategy` to `auto-merge`.

## Gray release and rollback

### Gray release is stuck at 0%

Older versions could hit this (nothing was selected yet the run continued with an empty batch). Now an empty gray selection aborts with an error: `灰度选择结果为空：……请调整 percentage/canaryDirs/filePatterns` ("the gray selection is empty: … adjust percentage/canaryDirs/filePatterns").

### What do `--full-release` and `--rollback` depend on?

On `.sync-gray.json` in the repository root. Do not delete it while a gray release is in progress; after a successful `--full-release` the state is cleaned up. `--rollback` also requires `grayReleaseConfig` to be enabled, otherwise it reports `--rollback 需要同时启用 grayReleaseConfig` ("--rollback requires grayReleaseConfig to be enabled as well").

### Does a failing validation script roll back automatically?

Not by default. Automatic rollback happens only when `grayReleaseConfig.rollbackOnFailure` is `true`; otherwise the failure status is recorded and it waits for you to run `--rollback` explicitly.

## Webhook

### I get 401

Three sources: the platform cannot be identified (no `x-github-event` / `x-gitea-event` / `x-gitlab-event`|`x-gitlab-token` / `x-event-key`, and `supportedPlatforms` lists more than one platform), the signature is missing or malformed, or the signature does not match. An empty secret means **every request is rejected** — that is deliberate.

### 403 / 429 / 413

`403` the IP is not in `securityConfig.ipWhitelist`; `429` (or the `statusCode` you configured) means the request exceeded the rate limit; `413` the body is larger than 1 MiB.

### 200, but no sync was triggered

The response body carries a `reason`: `非触发分支: xxx` ("non-triggering branch: xxx") or `事件不在允许列表: xxx` ("event not in the allow list: xxx"), or the event filter rules simply did not match. Branch comparison uses the short name with `refs/heads/` stripped. The order of the three filtering stages is in [Event filtering](/en/guide/webhook#event-filtering).

### Does a failed sync take the service down?

No. The service answers `202 { accepted: true }` first, runs the sync in the background, and a failure only writes to the log.

### Can the secret be read from an environment variable?

No — the tool **does not read environment variables at all**. `webhookConfig.secret` must be a value in the configuration, or your CI/shell must expand it into `--webhook-secret "$SYNC_WEBHOOK_SECRET"`. Make sure a configuration file committed to the repository contains no real secret.

### There is a reverse proxy in front — what do the IP allow list and rate limit use?

The first hop of `x-forwarded-for` (the connection's remote address when that header is absent). That header is client-controllable, so exposing the service directly to the public internet lets it be forged — treat the allow list as defence in depth only, and your front proxy must overwrite this header.

## Troubleshooting

### How do I read the common errors?

| Error | What to do |
|---|---|
| `Not a git repository` | Run `git init` in the current directory |
| `上游分支 x 在 <redacted url> 中不存在` ("upstream branch x does not exist in `<redacted url>`") | Check the branch name; the URL in the log is already redacted |
| `目标分支 x 既不在本地也不在 origin，请先创建后重试` ("target branch x exists neither locally nor on origin, create it and retry") | Preview mode will not create the branch for you — verify the branch name first |
| `认证失败，请检查仓库权限或 --auth 配置` ("authentication failed, check repository permissions or the --auth configuration") | Check the token scope / private key; for a passphrase-protected key, add it to ssh-agent first |
| `工作区存在未提交改动，git 拒绝了本次操作` ("uncommitted changes in the working tree, git rejected this operation") | Commit or stash your local changes first (conflicted files in particular) |
| `推送到 origin/xxx 失败` ("push to origin/xxx failed") | The commit is already local; after checking permissions and branch protection you can `git push` separately |

### What do the exit codes mean?

`0` success (including "no changes", a preview run, and cancelling with `Ctrl+C` in an interactive prompt) · `1` unexpected error, or some files failed to apply · `2` configuration/validation failure or an unknown command-line flag · `3` git operation failure · `4` corresponds to user cancellation and is a **reserved code**: the cancel path currently exits with `0`, so scripts cannot observe 4. The classification is in [Exit codes](/en/guide/automation#exit-codes).

### How do I see detailed logs?

```bash
sync-upstream -V    # verbose level + full change list
sync-upstream -s    # error output only
```

`-V` sets the level to verbose: plans are no longer truncated to 40 entries and verbose messages are let through. It **does not include debug** — today the only debug output is the per-file `冲突已解决: 路径 → 动作` ("conflict resolved: path → action"), and no command-line switch can reach that level; it is only reachable when the tool is used as a library. When `-V` and `-s` are both given, `-V` wins. Logs go to the console only; the tool writes no log file. See [Logging](/en/guide/automation#logging).

### I want a clean restart after something went wrong

1. `git status` to inspect the working tree (files with conflict markers may still need your attention after the tool committed)
2. `git log -1 --stat` to see exactly which paths that sync commit carried
3. To undo: `git reset --hard HEAD~1` (make sure you understand what you are discarding first); for a gray release prefer `sync-upstream -gr --rollback`
4. Optional: delete `.sync-state.json` and re-run with `--force`

### Will it touch my `origin`?

No. Upstream is added as a separate remote named `sync-upstream` (visible with `git remote -v`), and its refs live under `refs/remotes/sync-upstream/<branch>`. Pushes go to the upstream tracked by `companyBranch`, which defaults to `origin/<branch>`.

### Where is the token stored?

URLs in logs and errors are always redacted (`//user:pass@host` → `//***@host`), but **with `--auth-type pat` or `user_pass` the credentials are written into `.git/config` as part of the remote URL** — that is how git itself stores credentials, not something the tool adds on top. On shared machines, or when `.git/config` may leave the machine (some CI caches, `git bundle`), switch to `ssh` (via `GIT_SSH_COMMAND`, which stores no credentials) or a credential helper, and run `git remote remove sync-upstream` when you are done.
