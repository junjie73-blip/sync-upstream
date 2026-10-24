# Overview

This page gives the full skeleton of one run and the entry points to each focused page. Operational detail is split by feature onto its own pages; jump wherever you need it.

## Where to start

| What you want to do | Go to this page |
|---|---|
| Decide whether this tool is the right fit | [vs. built-in fork sync](/en/guide/vs-fork-sync) |
| Install it and get a first preview working | [Quick start](/en/guide/quick-start) |
| Read the plan output, run a real sync, understand the commit boundary | [Everyday sync](/en/guide/sync-basics) |
| Handle files that both you and upstream changed | [Conflicts](/en/guide/conflicts) |
| Ship a small part first, then go full or roll back | [Gray release](/en/guide/gray-release) |
| Sync automatically when upstream pushes | [Webhook daemon](/en/guide/webhook) |
| Wire it into a pipeline or a scheduled job | [CI and automation](/en/guide/automation) |
| Undo the sync you just ran | [Everyday sync](/en/guide/sync-basics) |
| Look up every flag, subcommand and alias | [CLI reference](/en/reference/cli) |
| Change config fields, check whether leftover files can be deleted | [Configuration reference](/en/reference/configuration) and [runtime files and cleanup](/en/reference/configuration#runtime-files-and-cleanup) |

## What happens in one run

1. Read the configuration (built-in defaults -> config file -> command line, the later one wins) and validate it completely, reporting every problem on the spot
2. Confirm the current directory is a Git repository, that the target branch is usable, and take this repository's sync lock (one real sync at a time per repository; when someone else holds the lock it waits according to `--lock-wait`, which by default fails straight away)
3. Fetch the upstream branch (network failures retry with backoff per the retry policy)
4. Compute the list of paths changing this time, applying ignore rules and the extension allow list
5. Mark the conflicting files that changed on both sides
6. Print the list — preview mode stops here
7. Only a real run continues: resolve conflicts -> write upstream content -> commit the paths applied -> record the incremental baseline -> push when asked

Every line the preview shows is a line that appears in the step 7 commit; both use the same list.

## Preview before you change anything

```bash
sync-upstream -P            # preview: no working tree changes, no branch switch, no commit
sync-upstream -n            # the same, for scripts that prefer dry-run
sync-upstream -P -V         # preview and list every changed path (only the first 40 show by default)
```

The plan looks like this (the tool prints Chinese unless you ask for another language):

```
计划: 163 项变更 (源 refs/remotes/sync-upstream/main → 目标 company/main)
+ packages/shared/src/new-file.ts (packages/shared)
~ packages/runtime-core/src/index.ts (packages/runtime-core)
- packages/shared/src/old.ts (packages/shared)
冲突: 2 个文件本地与上游都有改动
  ! packages/shared/src/const.ts [content]
跳过 7 个文件 — 被忽略规则排除
本地已修改文件 3 个（仅同步目录内）
```

`计划: 163 项变更 (源 … → 目标 …)` reads "Plan: 163 changes (source … -> target …)", `冲突: 2 个文件本地与上游都有改动` reads "Conflicts: 2 files changed locally and upstream", `跳过 7 个文件 — 被忽略规则排除` reads "Skipped 7 files - excluded by ignore rules", and `本地已修改文件 3 个（仅同步目录内）` reads "3 locally modified files (inside the sync directories only)". Add `--lang en` and the same run prints all of that in English.

`+` added, `~` modified, `-` deleted. The meaning of each line and skips such as `已是最新` (already up to date) and `不在同步目录内` (outside the sync directories) are in [Everyday sync](/en/guide/sync-basics).

## The four read-only subcommands

When you want to confirm the state before syncing, or find out afterwards why a file was left alone, use these four read-only subcommands. They never write to the working tree, switch branches, or commit, and all of them are safe to run from a pipeline.

```bash
sync-upstream status                 # branch, target branch, pending counts, config, repo lock and upstream snapshot (stays offline)
sync-upstream status --fetch         # fetch upstream first and then compare, which is closer to a real run
sync-upstream why src/a.ts           # whether this file is synced this time, and why
sync-upstream doctor                 # a check-up: Node/git, config, credentials, branches, sync directories, state file, repo lock, working-tree changes, plus webhook / notifications / gray release / delete and rename policy / fetching / logging / PR mode
sync-upstream history --limit 5      # what the last five syncs changed
```

All four accept `--json`, and what they print is one document you can feed straight to `jq`: with `--json` on, stdout carries only that JSON (no coloured lines and no human-readable layout), while logs still go to stderr and to the log file exactly as before. The same summary is also appended to `$GITHUB_STEP_SUMMARY` whenever that variable exists, so the GitHub Actions run page shows the numbers without any extra work.

`history` reads the records `sync-upstream` leaves behind after every real sync; there is nothing to switch on. `--limit` defaults to 10.

`status`, `doctor`, `history` and `--undo` also run with no config file at all: they are the commands for the "not configured yet / configured wrong" case, so each missing field is listed in the output and in the `warnings` array of `--json`, and `doctor` counts it as a blocker (exit code 1). `why` is the one exception — its answer is "will this sync touch this file", and without a usable configuration there is no plan to answer from, so it exits 2 with the validation failure.

## Four common gotchas

- **Preview still writes to `.git`**: it adds or updates the `sync-upstream` remote and fetches; it just does not touch the working tree, switch branches, or commit. When you are offline, a failing fetch is a hard error.
- **`syncDirs` accepts directories as well as single file paths**, so "sync just one file" needs no special mode — see [single files and partial scopes](/en/guide/automation#single-files-and-partial-scopes).
- **`-y` does not mean never asking**: as soon as the config is missing `upstreamRepo` or `syncDirs` is empty, the tool still enters the prompt flow to fill them in. In CI make the config complete — see [CI and automation](/en/guide/automation).
- **The output language follows your system locale**: when your machine's `LANG`/`LC_ALL` is not set to Chinese, help and error messages come out in English. Pin it with `SYNC_UPSTREAM_LANG=zh`, or pass `--lang zh` on every call. The precedence order and the exceptions are in [CLI reference → Language](/en/reference/cli#language-lang).

## Handy commands

```bash
sync-upstream init                       # answer a few questions to get a config file (start here the first time)
sync-upstream -y -C sync-upstream.config.json --push   # non-interactive sync and push
sync-upstream --conflict-strategy auto-merge           # resolve conflicts with a three-way merge
sync-upstream --no-delete -P                           # preview, but leave files upstream deleted alone for now
sync-upstream --fetch-filter blob --fetch-depth 50     # large repos: fetch only the part you need
sync-upstream --pr -P                                  # preview which branch PR mode would push to
sync-upstream -gr --percentage 20 -V                   # gray release: ship 20% first
sync-upstream -gr --full-release                       # after the gray release checks out, finish with everything
sync-upstream -gr --rollback                           # back to the state before the gray release
sync-upstream --undo                                   # undo the last real sync
sync-upstream -we --webhook-port 3000                  # webhook daemon
sync-upstream --lang en --help                         # read the help in English
sync-upstream completion bash                          # print a shell completion script
```

The behavioural boundary of each command is explained on its own page; the complete flag list is in the [CLI reference](/en/reference/cli).
