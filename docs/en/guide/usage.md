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
| Look up every command line flag and alias | [CLI reference](/en/reference/cli) |
| Change config fields, check whether leftover files can be deleted | [Configuration reference](/en/reference/configuration) and [runtime files and cleanup](/en/reference/configuration#runtime-files-and-cleanup) |

## What happens in one run

1. Read the configuration (built-in defaults -> config file -> command line, the later one wins) and validate it completely, reporting every problem on the spot
2. Confirm the current directory is a Git repository and the target branch is usable
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

The plan looks like this:

```
Plan: 163 changes (source refs/remotes/sync-upstream/main -> target company/main)
+ packages/shared/src/new-file.ts (packages/shared)
~ packages/runtime-core/src/index.ts (packages/runtime-core)
- packages/shared/src/old.ts (packages/shared)
Conflicts: 2 files changed locally and upstream
  ! packages/shared/src/const.ts [content]
Skipped 7 files - excluded by ignore rules
3 locally modified files (inside the sync directories only)
```

`+` added, `~` modified, `-` deleted. The meaning of each line and skips such as `已是最新` (already up to date) and `不在同步目录内` (outside the sync directories) are in [Everyday sync](/en/guide/sync-basics).

## Three common gotchas

- **Preview still writes to `.git`**: it adds or updates the `sync-upstream` remote and fetches; it just does not touch the working tree, switch branches, or commit. When you are offline, a failing fetch is a hard error.
- **`syncDirs` accepts directories as well as single file paths**, so "sync just one file" needs no special mode — see [single files and partial scopes](/en/guide/automation#single-files-and-partial-scopes).
- **`-y` does not mean never asking**: as soon as the config is missing `upstreamRepo` or `syncDirs` is empty, the tool still enters the prompt flow to fill them in. In CI make the config complete — see [CI and automation](/en/guide/automation).

## Handy commands

```bash
sync-upstream -y -C sync-upstream.config.json --push   # non-interactive sync and push
sync-upstream --conflict-strategy auto-merge           # resolve conflicts with a three-way merge
sync-upstream -gr --percentage 20 -V                   # gray release: ship 20% first
sync-upstream -gr --full-release                       # after the gray release checks out, finish with everything
sync-upstream -gr --rollback                           # back to the state before the gray release
sync-upstream -we --webhook-port 3000                  # webhook daemon
```

The behavioural boundary of each command is explained on its own page; the complete flag list is in the [CLI reference](/en/reference/cli).
