# Everyday sync

This page covers the four things you hit in almost every sync: preview, interactive prompts, the apply and commit boundary, and branch strategy. Conflicts, gray release, webhooks and CI each have their own page; start from the [usage overview](/en/guide/usage).

## Preview before you change anything

```bash
sync-upstream -P            # preview: no working tree changes, no branch switch, no commit
sync-upstream -n            # the same, for scripts that prefer dry-run
sync-upstream -P -V         # preview and list every changed path (only the first 40 show by default)
```

The plan looks like this:

```text
Plan: 163 changes (source sync-upstream/main -> target company/main)
+ packages/shared/src/new-file.ts (packages/shared)
~ packages/runtime-core/src/index.ts (packages/runtime-core)
- packages/shared/src/old.ts (packages/shared)
Conflicts: 2 files changed locally and upstream
  ! packages/shared/src/const.ts [content]
Skipped 7 files - excluded by ignore rules
3 locally modified files (inside the sync directories only)
```

`+` added, `~` modified, `-` deleted; the value in parentheses is the sync scope that matched (a `syncDirs` entry, which may be a directory or a single file). Skip reasons come in four kinds:

| Reason | Printed text | Trigger |
|---|---|---|
| `ignored` | `被忽略规则排除` (excluded by ignore rules) | matches the built-in ignores, `.gitignore`, `.syncignore`, `ignorePatterns`, or a directory-level `.gitignore` |
| `file-type` | `文件类型不在白名单` (file type not in the allow list) | `includeFileTypes` is set and the extension is not in that list |
| `already-synced` | `已是最新` (already up to date) | in incremental mode (`forceOverwrite: false` / `--incremental`), the file's upstream content matches what `.sync-state.json` records, so there is nothing new |
| `outside-sync-dirs` | `不在同步目录内` (outside the sync directories) | files outside the scope never enter the plan, so this one normally does not appear in the output and exists for diagnostics only |

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

The apply summary is one line:

```text
Apply complete: 160 files written, 2 kept local, 1 failed
  x packages/shared/src/blocked.ts: ...reason...
```

The commit line:

```text
Committed 1a2b3c4d (163 files)
```

The number in parentheses is the **file count** this commit carries and has nothing to do with the dirty file count in `git status`. When the plan is not empty but no staged diff is produced in the end, the tool prints `未提交: 计划中的 N 项变更未产生暂存差异，目标分支已与上游一致` ("nothing committed: the N planned changes produced no staged diff, the target branch already matches upstream") — that is not an error; it happens whenever you re-run identical content. "Changes planned but nothing committed" has only two causes: the target branch's content already equals upstream, or those paths were kept locally by conflict decisions.

The push target comes from the upstream branch that the target branch tracks. With no tracking information it falls back to the branch of the same name on `origin`, and if the repository has no `origin` at all it errors out. A failed push keeps the local commit and reports exit code 3, so you can run `git push` yourself. One boundary to watch: if the target branch tracks a branch on the `sync-upstream` remote, `-p` pushes to the upstream repository — keep company branches tracking `origin`.

## Full vs incremental

| Way | Config equivalent | Behaviour |
|---|---|---|
| `--force` (default `forceOverwrite: true`) | ignores the state file | applies every change in the plan |
| `--incremental` | `forceOverwrite: false` | checks the records in `.sync-state.json`, skips files whose upstream content has no new changes, and handles only what is new |

The state file is bound to "upstream repo + upstream branch", so switching upstreams rebuilds it automatically. It is a cache that is safe to delete — after deleting it, the next full comparison is enough. Paths deleted during this sync are cleared from the records too, so they are never mistaken for "already synced" next time. What each runtime artefact is for and whether you may delete it is in [runtime files and cleanup](/en/reference/configuration#runtime-files-and-cleanup).

## What ends up in the commit

The commit carries only the paths applied in this run. So:

- other people's uncommitted changes and untracked build output in your working tree stay out of it
- when upstream merely moves a file (a rename), the deletion of the old path and the write of the new one land in the same commit, leaving no stale path behind
- submodule pointers and other non-file entries do not take part in the sync
- nothing outside the sync scope is read, modified, or committed

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

The `autoSwitchBack` and `autoDeleteMergedBranches` keys have no effect today: setting them gives you no "switch back automatically after the sync" and no "clean up merged branches".

## What happens to your local changes

Files inside the sync scope that you modified locally but have not committed (tracked changes visible in `git status`) also take part in conflict detection:

- upstream modifies a file you modified locally -> `content` conflict
- upstream deletes a file you modified locally -> `delete-modify` conflict
- a path added by upstream exists on your side as an untracked file -> `untracked-overwrite` conflict

Details in [conflict handling](/en/guide/conflicts).
