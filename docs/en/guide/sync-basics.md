# Everyday sync

What comes up in one ordinary sync: preview, interactive prompts, the apply and commit boundary, the repository lock, renames and delete policies, multiple upstreams, branch strategy, undo, and the sync log. Conflicts, gray release, webhooks and CI each have their own page; start from the [usage overview](/en/guide/usage).

## Preview before you change anything

```bash
sync-upstream -P            # preview: no working tree changes, no branch switch, no commit
sync-upstream -n            # the same, for scripts that prefer dry-run
sync-upstream -P -V         # preview and list every changed path (only the first 40 show by default)
```

The plan looks like this (the tool prints Chinese unless you ask for another language):

```text
计划: 163 项变更 (源 sync-upstream/main → 目标 company/main)
+ packages/shared/src/new-file.ts (packages/shared)
~ packages/runtime-core/src/index.ts (packages/runtime-core)
> packages/shared/src/old-name.ts → packages/shared/src/new-name.ts 相似度 92% (packages/shared)
- packages/shared/src/dropped.ts (packages/shared)
冲突: 2 个文件本地与上游都有改动
  ! packages/shared/src/const.ts [content]
跳过 7 个文件 — 被忽略规则排除
本地已修改文件 3 个（仅同步目录内）
```

The header reads "Plan: 163 changes (source sync-upstream/main -> target company/main)", and the trailing lines read "Conflicts: 2 files changed locally and upstream", "Skipped 7 files - excluded by ignore rules", and "3 locally modified files (inside the sync directories only)". Add `--lang en` and the same run prints all of that in English.

`+` added, `~` modified, `-` deleted, `>` renamed (old path → new path, with the similarity: `相似度 92%` is 92% similar); the value in parentheses is the sync scope that matched (a `syncDirs` entry, which may be a directory or a single file). At most 40 lines print by default, and `-V` prints all of them. Skip reasons come in these classes:

| Reason | Printed text | Trigger |
|---|---|---|
| `ignored` | `被忽略规则排除` (excluded by ignore rules) | matches the built-in ignores, `.gitignore`, `.syncignore`, `ignorePatterns`, or a directory-level `.gitignore` |
| `file-type` | `文件类型不在白名单` (file type not in the allow list) | `includeFileTypes` is set and the extension is not in that list |
| `already-synced` | `已是最新` (already up to date) | in incremental mode (`forceOverwrite: false` / `--incremental`), the file's upstream content matches what `.sync-state.json` records, so there is nothing new |
| `outside-sync-dirs` | `不在同步目录内` (outside the sync directories) | files outside the scope never enter the plan, so this one normally does not appear in the output and exists for diagnostics only |
| `submodule` | `子模块（gitlink）无法按文件同步` (a submodule, i.e. a gitlink, cannot be synced file by file) | the path is a submodule pointer on one side, which file-level sync cannot express; add or update it by hand in the target repository with `git submodule add/update` |
| `symlink-unsupported` | `本地 core.symlinks=false，符号链接未写入` (`core.symlinks` is off locally, so the symlink was not written) | symlinks are not enabled in this repository (the default on Windows without developer mode), where checking out a symlink only writes a text file containing the target path |
| `delete-protected` | `上游删除但被删除策略保留` (deleted upstream, kept by the delete policy) | `deletePolicy` is `keep`, or you chose to keep it when `ask` asked; see [When upstream deletes a file](#when-upstream-deletes-a-file) |

Preview and real runs share one plan: every change you see in the preview shows up in the commit, and the commit never carries a file the preview did not list (apart from files kept locally by a conflict decision).

## Interactive mode

Without `-y`, the tool first asks you to fill in whatever is missing among `upstreamRepo`, `syncDirs`, `upstreamBranch`, `companyBranch` and `commitMessage`, then always asks the same 5 optional questions: push or not, preview or not, retry concurrency for failures, conflict strategy, and finally the confirmation to start.

Key points:

- **`-y` does not mean "never ask"**: if either `upstreamRepo` or `syncDirs` is empty the tool still asks, even with `-y` — in CI put both in the config file or pass them with `-r` / `-d`
- answering "no" to `确认开始同步?` (the "start syncing?" confirmation) is the same as cancelling
- pressing `Ctrl+C` to cancel prints `操作已取消` ("operation cancelled") and exits with code **0**; that is not a failure
- pressing `Ctrl+C` at a single conflicting file's prompt does not abort the whole run; that file is handled as "keep local"
- under `-y` the `prompt-user` conflict strategy degrades to "keep local" with a warning, so it can never hang waiting for input

```bash
sync-upstream -y -C sync-upstream.config.json --push
```

## Running for real

```bash
sync-upstream                       # run with the config file's settings
sync-upstream -p                    # push on top of that
sync-upstream --conflict-strategy auto-merge
```

The apply result is one summary line:

```text
应用完成: 160 个文件写入, 2 个保留本地, 1 个失败
  x packages/shared/src/blocked.ts: ...原因...
```

That reads "Apply complete: 160 files written, 2 kept local, 1 failed", and `...原因...` is the reason for that one file. The commit line:

```text
已提交 1a2b3c4d（163 个文件）
```

which reads "Committed 1a2b3c4d (163 files)". The number in parentheses is the **file count** this commit carries and has nothing to do with the dirty file count in `git status`. When the plan is not empty but no staged diff is produced in the end, the tool prints `未提交: 计划中的 N 项变更未产生暂存差异，目标分支已与上游一致` ("nothing committed: the N planned changes produced no staged diff, the target branch already matches upstream") — that is not an error; it happens whenever you re-run identical content. "Changes planned but nothing committed" has only two causes: the target branch's content already equals upstream, or those paths were kept locally by conflict decisions.

The push target comes from the upstream branch that the target branch tracks. With no tracking information it falls back to the branch of the same name on `origin`, and if the repository has no `origin` at all it errors out. A failed push keeps the local commit and reports exit code 3, so you can run `git push` yourself. One boundary to watch: if the target branch tracks a branch on the `sync-upstream` remote, `-p` pushes to the upstream repository — keep company branches tracking `origin`.

## One sync at a time per repository

Two syncs sharing one working tree step on each other: checkout, `git rm`, staging and committing interleave, and in the end both processes commit content nobody planned. The usual trigger is a webhook delivery while someone also runs it by hand. So every run takes the repository lock (`.git/sync-upstream.lock`) before it does anything — previews and `--undo` included — and releases it when the run ends.

```bash
sync-upstream                      # fails at once if the lock is taken
sync-upstream --lock-wait 30000    # wait up to 30 seconds, then fail
```

- the default is `lockWaitMs: 0`, which means no waiting: as soon as another run holds the lock the run fails with exit code **5**, and the message names the holder's pid, task label, start time and lock file path
- while `--lock-wait <ms>` is in effect the lock is retried every 200ms, and `-V` prints how long it has waited
- a lock whose owning process has exited, or whose age exceeds 30 minutes, is treated as stale and taken over automatically, with a `发现过期锁（pid … 已退出或超过 1800s），接管: …` line ("stale lock found (pid ... exited or older than 1800s), taking over: ...")
- if a running sync notices the lock is no longer its own (it was taken over after a timeout), it stops immediately so its commits cannot interleave with the new holder's
- for a lock left behind by a crash that does not count as stale, confirm no other process is running and then delete `.git/sync-upstream.lock`
- deliveries queued by the daemon run one after another inside the same process, so they never fight over this lock

## Full vs incremental

| Way | Config equivalent | Behaviour |
|---|---|---|
| `--force` (default `forceOverwrite: true`) | ignores the state file | applies every change in the plan |
| `--incremental` | `forceOverwrite: false` | checks the records in `.sync-state.json`, skips files whose upstream content has no new changes, and handles only what is new |

The state file is bound to "upstream repo + upstream branch + company branch", so changing any one of the three rebuilds it automatically. Deleting it corrupts nothing, but you lose the incremental baseline along with the `history` records and the reference `--undo` needs, so the next run compares everything — treat it as local state and do not commit it. A record stores the file's mode alongside the upstream content hash, so a permissions-only change (adding an executable bit, for instance) also counts as new. Paths deleted during this sync are cleared from the records too, so they are never mistaken for "already synced" next time. With multiple upstreams each source keeps its own state file and they stay out of each other's way. What each runtime artefact is for and whether you may delete it is in [runtime files and cleanup](/en/reference/configuration#runtime-files-and-cleanup).

## What ends up in the commit

The commit carries only the paths applied in this run. So:

- other people's uncommitted changes and untracked build output in your working tree stay out of it
- when upstream moves a file as-is, a change detected as a rename is applied with one `git mv`; a pair it cannot detect lands in the same commit as "delete the old path + write the new one", leaving no stale path behind
- submodule pointers and other non-file entries do not take part in the sync
- nothing outside the sync scope is read, modified, or committed

## Rename detection

When upstream renames a file (content barely changed), the tool reads it as one rename instead of "delete the old file and add a new one": the plan prints a `>` line, the apply does it with `git mv`, and both the file's history and your local changes survive.

```bash
sync-upstream --no-renames           # turn detection off, back to delete + add
sync-upstream --renames              # turn it on explicitly (when the config turns it off)
sync-upstream --rename-threshold 80  # similarity threshold, default 60 (percent)
```

The matching config keys are `renameDetection` (default `true`) and `renameThreshold` (default `60`, allowed 1-100). A delete/add pair below the threshold is still handled as two files. Three situations switch rename detection off by themselves and warn you, while the run keeps syncing normally:

- `deletePolicy: keep` — a rename also removes the old path, which contradicts the promise never to delete local files
- a gray release — a rename can only be applied as a whole, not in percentage batches
- `fetchConfig.depth` — content of old paths beyond the fetch depth is unavailable, so there is nothing to compute similarity against

A rename can also cause conflicts: the old path has uncommitted local changes and upstream changed its content -> `delete-modify`; the new path already exists on your side as an untracked file -> `untracked-overwrite`. Details in [conflict handling](/en/guide/conflicts).

## When upstream deletes a file

Whether your copy goes away too is up to `deletePolicy` (default `mirror`):

| Policy | Behaviour | Command line |
|---|---|---|
| `mirror` | follows upstream and deletes it; the old path enters the commit | `--delete-policy mirror`, or `--delete` |
| `keep` | your file stays exactly as it is, and the plan records it as the `delete-protected` skip | `--delete-policy keep`, or `--no-delete` |
| `ask` | one question per run; answering "no" keeps the files | `--delete-policy ask` (there is no separate `--ask` switch) |

With `ask`, every run asks one question — "upstream deleted N files, delete them in this run too?" — where "no" is the default answer and `Ctrl+C` also counts as "no". Whenever no answer can be collected, the tool keeps the files and warns: that is what happens under `-y`, with `--json`, and in preview mode, because a missed deletion can be picked up next run while a mistaken one nobody approved cannot be undone. `--delete` / `--no-delete` override `deletePolicy` from the config file, which suits a change of mind for one run.

## Multiple upstreams and any ref

One run can pull changes from several upstreams (fan-in): write the `upstreams` array, or repeat `-r` / `-b` on the command line.

```bash
sync-upstream \
  -r https://github.com/vuejs/core.git -b main \
  -r https://github.com/vuejs/router.git -b master
```

- an array entry accepts `repo`, `branch`, `dirs` and `message`; anything you leave out comes from the top-level config
- repeated `-r` / `-b` values pair up by position, and the shorter side reuses its first value, so `-r a -r b -b main` is legal
- sources are processed in config order and each one prints a separator line `── 源 1/2: 仓库名@分支` ("source 1/2: repo name@branch"); if a source fails the run stops and the remaining sources are not executed
- each source is fetched into its own remote (the first is still `sync-upstream`, the others are `sync-upstream-2`, `sync-upstream-3`, ...) and gets its own incremental state file and its own commit
- with more than one source in `upstreams`, gray release, `--rollback` and `--full-release` are refused outright (exit code 2); see [gray release](/en/guide/gray-release)

`upstreamBranch` (including the `branch` of every entry) accepts any upstream ref: a branch, a tag, a commit, or the full `refs/…` form. The log and the output say whether it was read as a branch, a tag or a commit. A value made purely of hex digits has to contain a letter before it is read as a commit — to point at an all-digit commit, write the `refs/…` form.

## Partial fetches and Git LFS

Syncing a few directories out of a monorepo used to mean pulling every object on the source branch. `fetchConfig` lets you fetch only what you need:

```bash
sync-upstream --fetch-filter blob   # blobless: commits and trees first, file content on demand
sync-upstream --fetch-filter tree   # treeless: commits only at first, the least traffic
sync-upstream --fetch-depth 50      # shallow fetch, only the 50 most recent commits
sync-upstream --fetch-tags          # also bring the tags down (default --no-fetch-tags)
```

- `filter` defaults to `none`, i.e. a full fetch, which is also the only mode where you can inspect upstream file content offline; `tree` noticeably raises the number of on-demand round trips, so a wide directory sync can end up slower than a full fetch
- `depth` turns your repository into a shallow one (`.git/shallow`): everyone else's `git log` gets shorter as well, and rename detection is switched off — set it only when you really need it
- `lfs` decides what a file stored in upstream Git LFS becomes locally: `pointer` (default, writes the pointer text only, no network at all and therefore never a failure because an LFS server is unreachable), `materialize` (fetches the real content after writing the pointer; needs `git-lfs` on this machine and a reachable upstream LFS server), or `off` (no detection at all)
- a failed fetch or a missing `git-lfs` only affects those files and never fails the run; how many pointers were hit, and which ones, is printed to the log, to `--json`, and to the CI summary

Each flag is listed in the [CLI reference](/en/reference/cli) and the config keys are in the [configuration guide](/en/guide/configuration).

## Branch strategy

Enable this when every sync must land on its own branch (it only takes effect in real runs; preview never switches branches):

```json
{
  "branchStrategyConfig": {
    "enable": true,
    "strategy": "feature",
    "baseBranch": "company/main",
    "branchPattern": "feature/sync-{date}"
  }
}
```

`branchPattern` supports `{date}` (`YYYY-MM-DD`), `{base}` and `{strategy}`; any `\` in it is normalized to `/`. If the branch already exists the tool switches to it, otherwise it creates it from `baseBranch`; a missing base branch is an error rather than something invented.

The two switches that clean up afterwards:

- `autoSwitchBack` (default `true`): after committing, the tool returns to the branch you were on when the run started, so you are not left sitting on `feature/sync-…`; set it to `false` to stay on the sync branch
- `autoDeleteMergedBranches` (default `false`): deletes old sync branches generated from the same `branchPattern` prefix that have already been merged into the target branch. Your current branch, the target branch and `baseBranch` are never deleted, unmerged branches are deleted with the ordinary `git branch -d`, and anything that refuses to be deleted is left alone

## Pull request mode

`prConfig` (`--pr`) turns the result into a branch waiting for review instead of landing it on the target branch: the changes are committed to an auto-generated `sync-upstream/{target}-{date}` (`{date}` is `yyyymmdd`), that branch is pushed, and then the tool tries to open the PR with `gh` / `glab`. If the platform CLI is missing or not allowed to create a PR, you only get a comparison link printed to open it yourself.

```bash
sync-upstream --pr --pr-draft         # push the branch, create the PR as a draft
sync-upstream --pr --pr-no-create     # push the branch only, open the PR yourself
```

Key points:

- the target branch is never touched; in PR mode `autoPush` does not push it (the tool says so) and pushes the PR branch instead
- when the branch name collides with an existing branch, `-2`, `-3` suffixes are used rather than adding commits to a branch that may be under review; if the run has no changes at all, no empty branch is left behind — the one just created is deleted
- a failed push or a missing `gh` is only a hint and does not fail the run — the local commit exists anyway
- PR mode neither reads nor writes the incremental state file: content on that branch has not reached the target branch yet, so recording it as "already synced" would mislead the next run
- `prConfig` is mutually exclusive with preview/`dryRun`, `branchStrategyConfig` and `grayReleaseConfig`; combining them is refused (exit code 2), see [Behaviour of each flag group](/en/reference/cli#behaviour-of-each-flag-group)
- `--pr-branch`, `--pr-remote`, `--pr-title` and `--pr-body` override the branch template, the remote to push to, and the PR title and body

## Sync history

Whenever a real run produces a commit, one entry is added to the history in the state file: the commit, the source it came from (the upstream branch, tag or commit), the time, the file count, the paths in that batch, and the HEAD and branch before the run. At most 50 entries are kept.

```bash
sync-upstream history            # the 10 most recent
sync-upstream history --limit 30
sync-upstream history --json
```

In the output `●` marks the most recent sync — the one `--undo` would take back, `当前 HEAD` ("current HEAD") says nothing has been committed on top of it since, and `commit 已不可用` ("commit no longer available") says the object was garbage-collected or the branch was rewritten. With multiple upstreams the histories are listed per source.

## Undo the last sync

```bash
sync-upstream --undo    # or -uo
```

The undo is a forward commit created with `git revert`, so nothing is rewritten — a sync commit may already be pushed and pulled by others. Its boundaries:

- only the newest record is considered; when that commit is no longer HEAD the tool does nothing and tells you to run `git revert <commit>` yourself
- if the recorded branch still exists but you are not on it, the tool switches to it first; if the branch is gone, it reports that the undo range cannot be determined
- after a successful undo the paths are marked as not synced in the incremental state and that history entry is removed, so the next sync applies the upstream content again
- `--undo` fetches nothing from upstream, it only reverts the one run on record; it takes the repository lock like any other run and, with `autoPush` configured, pushes the revert commit to the target branch
- when the state file has no history (before the first sync, or in a file written by an older version) the tool prints `未撤销` ("nothing undone") and exits with code 1

A successful undo looks like this:

```text
已撤销同步 1a2b3c4d（163 个文件）
  撤销提交: 9f8e7d6c · 分支 company/main
  增量状态里这些路径已标记为未同步，下次同步会重新应用上游内容。
```

Those three lines read "Sync undone: 1a2b3c4d (163 files)", "Revert commit: 9f8e7d6c · branch company/main", and "These paths are marked as not synced in the incremental state, so the next sync re-applies the upstream content."

The gray release batches and its rollback work differently; see [gray release and rollback -> What rollback actually does](/en/guide/gray-release#what-rollback-actually-does).

## What happens to your local changes

Files inside the sync scope that you modified locally but have not committed (tracked changes visible in `git status`) also take part in conflict detection:

- upstream modifies a file you modified locally -> `content` conflict
- upstream deletes a file you modified locally -> `delete-modify` conflict
- a path added by upstream exists on your side as an untracked file -> `untracked-overwrite` conflict

Details in [conflict handling](/en/guide/conflicts).
