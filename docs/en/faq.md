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

### Where do I start writing a configuration file?

Two ways. `sync-upstream init` asks only the few questions that decide the outcome of the sync (upstream URL, branch, target branch, sync directories, and so on) and writes the answers into a file small enough to read in one go; if the target file already exists you need `--force` to overwrite it, and under `--json` or `-y` the wizard refuses outright. For a complete default template use `-g, --generate-config`, with the format chosen by `-F, --config-format json|json5|yaml|toml`.

### Why did my configuration file not take effect?

You now get an explicit error instead of a silent fallback: if the file given to `-C` does not exist, is unreadable, has a syntax error, is empty, or has a non-object top level, the run aborts and says why; a parse failure also lists the JSON / YAML / TOML errors separately. Without `-C`, 16 candidate file names are searched in a fixed order, and if none is found you get a warning that spells out the search scope.

### I wrote fields like `targetBranch` / `maxRetries` — does the tool understand them?

Yes, they are historical aliases and are rewritten automatically to `companyBranch` / `retryConfig.maxRetries` with a one-time warning. If an alias has the wrong value type it is a hard error (for example `maxRetries: "abc"`). To avoid aliases entirely, write the canonical keys as documented in the [configuration reference](/en/reference/configuration).

### Why do I see `未识别的配置项 xxx 已忽略` ("unrecognized configuration option xxx ignored")?

That key belongs to neither a canonical field nor an alias, so it is most likely a typo. The tool refuses to let it fail silently, hence the explicit warning.

### Why do I only see the first configuration error?

It is not only one — validation collects every problem and prints them at once (listed line by line after `配置校验失败:` — "configuration validation failed:"). After you fix them, the next run may reveal the remaining problems, but those belong to a later stage.

### Where did the cache options go, and is LFS still configurable?

The cache layer is gone: the incremental decision now uses the content hashes git already records, and the state file is itself the evidence, so a separate cache layer brings no benefit any more. Keys such as `cache`, `cacheConfig`, and `adaptiveConcurrency` do not fail silently either — you get a one-time warning that they are `已废弃并被忽略` ("deprecated and ignored") plus an explanation of what decides things now (concurrency comes only from `concurrencyLimit`).

LFS has its own configuration again, but not under the old name: `fetchConfig.lfs` takes `pointer` (the default, sync the pointer text only), `materialize` (fetch the real content with git-lfs after writing the pointer, which needs git-lfs installed locally and a reachable upstream LFS server), or `off` (no detection at all). Large-file transfer itself is still git's job, driven by `.gitattributes` in the repository. The same section also holds `filter` (partial fetch) and `depth` — see [fetchConfig in the configuration reference](/en/reference/configuration#fetchconfig).

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

Start with the `跳过 … 条` ("skipped … entries") summary at the end of the plan — every entry has a name: `被忽略规则排除` (excluded by an ignore rule), `文件类型不在白名单` (file type not in the allow list), `不在同步目录内` (outside the sync directories), `已是最新` (already up to date — incremental mode), `子模块（gitlink）无法按文件同步` (a submodule pointer cannot be synced file by file), `上游删除但被删除策略保留` (deleted by upstream but kept by the delete policy), `本地 core.symlinks=false，符号链接未写入` (`core.symlinks=false` locally, so the symlink was not written). To get the verdict for one **specific file**, do not guess: `sync-upstream why <path>` answers from the very same comparison the real plan used, and there are only five conclusions — `会同步` (will be synced), `需要冲突处理` (needs conflict handling), `不会同步` (will not be synced, naming the ignore rule that matched and the file it came from), `已与上游一致` (already matches upstream), `未找到该文件` (file not found). Add `--fetch` to contact upstream first, add `--json` for machine reading. For the overall picture run `sync-upstream status` (skip reasons grouped by count), and to check whether the environment is usable run `sync-upstream doctor`.

### Upstream moved a file — will the old path stay behind?

Not by default. Rename detection is on (`renameDetection: true`, with the similarity bar at `renameThreshold: 60`, i.e. git's `--find-renames`), so the old path and the new path land in the same commit as one rename, and the preview shows them as `>` with the similarity percentage; no stale path is left behind.

Rename detection is switched off, with a warning, in these cases: `--no-renames` explicitly disables it, `deletePolicy: 'keep'`, a gray release is in progress, or `fetchConfig.depth` asks for a shallow fetch. Then the move is treated as two entries, "deleted upstream" plus "added upstream": the new path syncs as usual, and whether the old path disappears depends on the delete policy — `mirror` (the default) deletes it, `keep` preserves it and records it as `上游删除但被删除策略保留` ("deleted by upstream but kept by the delete policy"), and `ask` asks you about it one by one after printing the plan. See [delete and rename handling in the configuration reference](/en/reference/configuration#deletion-and-renames).

### Can I delete `.sync-state.json`?

Yes — it is equivalent to a disposable incremental cache: after deleting it the next comparison is a full one (with the default `forceOverwrite: true` the file is never used to skip files anyway; only `--incremental` / `"forceOverwrite": false` relies on it). When you switch upstream repository or upstream branch, the file is rebuilt automatically. The only real cost is that the file also carries the most recent sync commits (up to 50 entries), so deleting it leaves `sync-upstream history` with nothing to show and `-uo` with nothing to undo — keep it if you want to stay able to roll back. Its location and cleanup advice are in [runtime files and cleanup](/en/reference/configuration#runtime-files-and-cleanup).

### How do I sync only some files inside a directory?

`syncDirs` sets the scope, `includeFileTypes` sets the extension allow list, and `ignorePatterns` / `.syncignore` handle exclusions. **Syncing a single file** needs no special pattern: a sync directory matches both directories and a file of the same name, so just write the file path into `syncDirs` (`"syncDirs": ["package.json"]`). Arbitrary path remapping (sync upstream path A into local path B) is not supported yet. See [Single files and partial scopes](/en/guide/automation#single-files-and-partial-scopes).

### Will it commit my uncommitted changes along the way?

No. The commit contains only the paths this sync actually applied. If there are uncommitted local changes inside a sync directory, they are listed as local changes and may be classified as conflicts, but they are never committed as a side effect.

### Can I run two syncs at the same time?

Not in parallel, but they cannot trample each other either: there is one lock, `.git/sync-upstream.lock` under the repository root, and the second process — with the default `lockWaitMs: 0` — fails immediately with exit code `5`, naming the holder's pid, task, and start time. To make the second one queue instead, set `lockWaitMs` or `--lock-wait <ms>`; webhook daemon mode relies on this very lock to serialise deliveries. A leftover lock is taken over automatically: immediately when the holding process has exited, and only after 30 minutes when the process is still alive but the lock is that old (which covers reused pids and separate pid spaces across machines). When in doubt run `sync-upstream doctor`, which reports either `仓库锁被占用` ("the repository lock is held") or `仓库锁空闲` ("the repository lock is free").

### What if I need to follow several upstreams at once?

Use `upstreams: [{ repo, branch, dirs, message }]`, i.e. fan-in: each upstream gets its own fetch remote (`sync-upstream`, `sync-upstream-2`…), its own incremental state file, and its own sync commit, and where directories overlap the later array entry overrides the earlier one. Repeating `-r` / `-b` on the command line is the shorthand for the same thing. Fields you leave out inherit the top-level configuration, but as soon as this list exists it replaces the top-level `upstreamRepo` / `upstreamBranch`. Limits: multiple upstreams and gray release are mutually exclusive (`-gr` / `-fr` / `-ro` fail outright), and the per-source state file names embed the ref and a hash, so they are not on the built-in ignore list — add `.sync-state-*.json` to `.gitignore`. See [upstreams in the configuration reference](/en/reference/configuration#multiple-upstream-sources).

### The upstream repository is huge — fetching is slow and fills the disk

What gets fetched is decided by `fetchConfig`: `filter: 'blob'` uses a partial fetch and does not download file content objects, `filter: 'tree'` also fetches tree objects on demand, `depth: n` takes only the last n commits (this makes your local repository shallow and switches rename detection off), `tags` leaves tags out by default, and when upstream uses Git LFS `lfs` takes `pointer` (sync the pointer text only, the default) / `materialize` (fetch the real content afterwards with git-lfs, which needs it installed locally and a reachable LFS server) / `off` (no detection at all). The matching flags are `--fetch-filter` / `--fetch-depth` / `--fetch-tags` / `--lfs`. See [fetchConfig in the configuration reference](/en/reference/configuration#fetchconfig).

### Can a sync commit be undone?

Yes, in two steps. `sync-upstream history` lists the recent syncs recorded in the state file (10 by default, adjusted with `--limit`, and `--json` for machine reading); `sync-upstream -uo` (`--undo`) undoes the most recently recorded sync by creating a new revert commit with `git revert`, so history is not rewritten and a branch that is already pushed stays safe to walk back. It only acts while that recorded commit is still HEAD; if you have stacked your own commits on top, it just prints `请手工执行 git revert <commit>` ("please run the revert on that commit by hand") rather than guessing your intent. After a successful undo it forgets those paths, so the next sync compares them again instead of being fooled by the incremental state. Note that PR mode does not write incremental state, so it also has nothing recorded to undo.

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

On `.sync-gray.json` in the repository root. Do not delete it while a gray release is in progress; after a successful `--full-release` the state is cleaned up. `--rollback` also requires `grayReleaseConfig` to be enabled, otherwise it reports `--rollback 需要同时启用 grayReleaseConfig` ("--rollback requires grayReleaseConfig to be enabled as well"). Multiple upstreams (fan-in via `upstreams`) and gray release are mutually exclusive: with `upstreams` present, `-gr` / `-fr` / `-ro` fail outright, so configure one upstream at a time when you need a gray release.

### Does a failing validation script roll back automatically?

Not by default. Automatic rollback happens only when `grayReleaseConfig.rollbackOnFailure` is `true`; otherwise the failure status is recorded and it waits for you to run `--rollback` explicitly.

## Webhook

### I get 401

Three sources: the platform cannot be identified (no `x-github-event` / `x-gitea-event` / `x-gitlab-event`|`x-gitlab-token` / `x-event-key`, and `supportedPlatforms` lists more than one platform), the signature is missing or malformed, or the signature does not match. An empty secret means **every request is rejected** — that is deliberate.

### 403 / 413 / 429 / 503 / 405 / 404

- `403`: the source IP is not in `webhookConfig.securityConfig.ipWhitelist`
- `413`: the request body exceeds the limit, 1 MiB by default, adjustable through `webhookConfig.maxBodyBytes` (1024 bytes at minimum)
- `429`: the rate limit was exceeded (the status code itself can be rewritten by `webhookConfig.securityConfig.rateLimit.statusCode`)
- `503`: the background sync queue is full (`webhookConfig.maxQueue`, 8 by default) or the service is shutting down. This is the redelivery signal for the platform, not a configuration error
- `405`: a method other than POST
- `404`: the path is neither `webhookConfig.path` nor the health endpoint (`/healthz` by default; `healthPath: false` turns it off)

### 200, but no sync was triggered

The response body carries a `reason`: `非触发分支: xxx` ("non-triggering branch: xxx"), `事件不在允许列表: xxx` ("event not in the allow list: xxx"), the event filter rules simply did not match, or `重复投递: xxx` ("duplicate delivery: xxx") — when the provider redelivers the same delivery id, the second attempt is only acknowledged, not synced again (`deduplicate` is on by default and can be turned off). Branch comparison uses the short name with `refs/heads/` stripped. The order of the three filtering stages is in [Event filtering](/en/guide/webhook#event-filtering).

### Does a failed sync take the service down?

No. The service answers `202 { accepted: true }` first, runs the sync in the background, and a failure only writes to the log. When `webhookConfig.deliveryLog` is set, a failure also appends a JSONL record whose `decision` is `failed` to the delivery audit, so you can still read it after the process exits; `sync-upstream doctor` prints the most recent entry so you can see that the service really is receiving deliveries.

### There is a reverse proxy in front — what do the IP allow list and rate limit use?

By default only the **remote address of the connection** is used — the hop in front of the server, which is your proxy's own IP. The first hop of `x-forwarded-for` is taken into account only after you explicitly set `webhookConfig.trustProxy: true`, because that header is client-controllable and can be forged when the service is exposed to the public internet directly. So the correct setup is: keep the default `host: 127.0.0.1` so only the local proxy can reach it, have the proxy overwrite `x-forwarded-for`, and only then turn `trustProxy` on; treat the allow list as defence in depth, never as the only gate. `sync-upstream doctor` flags these combinations: listening publicly without an `ipWhitelist` (warning), `trustProxy=true` (a reminder that it now takes part in the allow-list and rate-limit decisions), and a non-loopback address without `tlsCert`/`tlsKey` (warning).

### Can the secret be read from an environment variable?

No — credentials are **never read from environment variables**: `webhookConfig.secret` is either a value in the configuration, or your CI/shell expands it into `--webhook-secret "$SYNC_WEBHOOK_SECRET"`. Make sure a configuration file committed to the repository contains no real secret.

The tool does read these non-sensitive environment variables, which are behaviour switches only and carry no credentials: `SYNC_UPSTREAM_LANG` (together with `LC_ALL` / `LANG` / `LANGUAGE` it decides the output language, equivalent to `--lang`), `GITHUB_STEP_SUMMARY` (when it exists the result summary is appended to that file), and `SYNC_UPSTREAM_PR_CREATE=0` (turns off automatic PR creation in PR mode).

## Troubleshooting

### How do I read the common errors?

| Error | What to do |
|---|---|
| `Not a git repository` | Run `git init` in the current directory |
| `上游分支 x 在 <redacted url> 中不存在` ("upstream branch x does not exist in `<redacted url>`") | Check the branch name; the URL in the log is already redacted |
| `目标分支 x 既不在本地也不在 origin，请先创建后重试` ("target branch x exists neither locally nor on origin, create it and retry") | Preview mode will not create the branch for you — verify the branch name first |
| `认证失败，请检查仓库权限或 --auth 配置` ("authentication failed, check repository permissions or the --auth configuration") | Check the token scope / private key; for a passphrase-protected key, add it to ssh-agent first |
| `工作区存在未提交改动，git 拒绝了本次操作` ("uncommitted changes in the working tree, git rejected this operation") | Commit or stash your local changes first (conflicted files in particular) |
| `仓库正被另一次同步占用（pid …，任务 …，开始于 …）。等待 Nms 后放弃；确认没有其它进程后可删除 … 强制解锁` ("the repository is busy with another sync (pid …, task …, started …); giving up after Nms; once you have confirmed no other process is running you can delete … to force-unlock") | Only one sync per repository at a time. Either wait for it to finish, or queue with `--lock-wait <ms>` / `lockWaitMs`; a lock whose holder has exited is taken over automatically, and you delete `.git/sync-upstream.lock` by hand only when the process is still alive and the file is genuinely a leftover. `sync-upstream doctor` tells you who holds it |
| `推送到 origin/xxx 失败` ("push to origin/xxx failed") | The commit is already local; after checking permissions and branch protection you can `git push` separately |

### What do the exit codes mean?

`0` success (including "no changes", a preview run, and cancelling with `Ctrl+C` during a sync) · `1` unexpected error, or some files failed to apply · `2` configuration/validation failure or an unknown command-line flag · `3` git operation failure · `4` user cancellation (today only cancelling inside `sync-upstream init` returns it; cancelling the sync flow still exits `0`) · `5` the repository is busy with another sync. The classification is in [Exit codes](/en/guide/automation#exit-codes).

### How do I see detailed logs?

```bash
sync-upstream -V          # verbose level + full change list
sync-upstream --debug     # one level lower, including per-file conflict decisions
sync-upstream -s          # error output only
```

`-V` sets the level to verbose: plans are no longer truncated to 40 entries and verbose messages are let through; `--debug` goes finer still and is a command-line switch only — there is no configuration key for it, so a config file can never open it by accident. `-s` has the highest priority, `-V` next.

To keep evidence on disk: `--log-file <path>` or `logConfig.file` writes the log to a file as well, tuned by `--log-level` (default `info`; set `debug` to capture debug lines), `--log-json` (one JSON object per line), `--log-max` (5 MiB by default), and `--log-keep` (5 rotated files by default). Lines written to the file first have their colour codes stripped, then account/password parts of URLs and values such as `token=` / `secret=` / `Bearer` are redacted. The console level and the file level are independent of each other. See [Logging](/en/guide/automation#logging) and [logConfig in the configuration reference](/en/reference/configuration#logconfig).

### I want a clean restart after something went wrong

1. `git status` to inspect the working tree (files with conflict markers may still need your attention after the tool committed)
2. `git log -1 --stat` to see exactly which paths that sync commit carried
3. To undo: prefer `sync-upstream -uo` — it creates a revert commit, does not rewrite history, and stays safe even when the branch is pushed; use `git reset --hard HEAD~1` only when you have confirmed that this sync commit is still only local. For a gray release use `sync-upstream -gr --rollback`
4. Optional: delete `.sync-state.json` and re-run (the next comparison is a full one anyway), at the cost of losing the sync records that `history` / `-uo` depend on

### Will it touch my `origin`?

No. Upstream is added as a separate remote named `sync-upstream` (visible with `git remote -v`), and its refs live under `refs/remotes/sync-upstream/<branch>`. Pushes go to the upstream tracked by `companyBranch`, which defaults to `origin/<branch>`.

### Where is the token stored?

URLs in logs and errors are always redacted (`//user:pass@host` → `//***@host`), but **with `--auth-type pat` or `user_pass` the credentials are written into `.git/config` as part of the remote URL** — that is how git itself stores credentials, not something the tool adds on top. On shared machines, or when `.git/config` may leave the machine (some CI caches, `git bundle`), switch to `ssh` (via `GIT_SSH_COMMAND`, which stores no credentials) or a credential helper, and run `git remote remove sync-upstream` when you are done.
