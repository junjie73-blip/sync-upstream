# Planned for the next release

This page lists gaps that are **confirmed to exist and not addressed by 0.3.0**, ordered by impact, as the candidate list for the next minor version (0.4.x). It is a plan, not a commitment: which items get built, and in what order, depends on feedback from actual use.

Each entry states three things: what happens today, what the next release intends to do, and how to work around it in the meantime. If one of them matters a lot to you, say so with your use case — that is what sets the priority.

## 1. English covering run logs and subcommand bodies

Today `--lang en` translates the **help text**, **flag errors**, **error messages**, and the **`init` questionnaire**. The log lines of a sync, the completion questions and conflict prompts inside a sync, the configuration summary, the bodies of `status` / `doctor` / `why` / `history`, the git diagnostics, and the gray release and notification wording are still Chinese, so a log file ends up mixed.

The next release intends to bring that wording into the same language key set, and to let programs that use this tool as a library switch the language from code.

In the meantime: reach for `--json` whenever you need machine-readable content. Its field names and decision tokens are English (`already-synced`, `delete-protected`, `ignored`, …) and are unaffected by the language; only explanatory text such as `note` and the `message` field of `doctor` is still Chinese.

## 2. Undoing a chosen sync, not only the newest one

Today `-uo` / `--undo` restores only the last sync recorded in the state file, and only when that sync commit is still exactly the tip of the branch. Older entries show up in `history` but have no undo path. The undo itself appends a new commit and never rewrites already-pushed history, so the revert still has to be pushed.

The next release intends to let `--undo` take the position or timestamp that `history` prints, and to list the paths an undo will touch before it does anything.

In the meantime: `history --json` gives the commit of every recorded sync, and `git revert <commit>` on it is the manual version of an undo (when HEAD has moved past the sync commit, `--undo` refuses and recommends exactly that).

## 3. State files written into `.gitignore` automatically

`.sync-state.json` is local incremental state, and with a single upstream it is on the built-in ignore list. With several upstreams each one writes its own `.sync-state-<name>-<hash>.json`; those names embed a hash, so they are not on the list and appear as untracked files after every sync. `doctor` calls this out with a `state-ignore` row.

The next release intends to add the required ignore entries while `init` / `--generate-config` write the configuration (with a switch to turn that off).

In the meantime: add one line, `.sync-state*.json`, to your `.gitignore`.

## 4. Gray release with several upstreams

Gray release, `--full-release` and `--rollback` currently require a single upstream; when the configuration holds several, these flags are refused outright (exit code 2). When several upstreams cover overlapping directories, the later entry in the list overrides the earlier one, and the run does not warn about that specifically.

The next release intends to scope the gray selection per upstream and to print an explicit list whenever directories overlap.

In the meantime: fan in one upstream at a time, or give each overlapping directory a single owning upstream.

## 5. Keeping credentials out of plain text

The `pat` and `user_pass` authentication methods write the credential into the remote URL in `.git/config`, where any other process on the machine can read it. `ssh` is not affected.

The next release intends to prefer the git credential helper and to accept credentials as environment references instead of plain text in the configuration file.

In the meantime: use `ssh`, or keep a credential-bearing repository in a working tree that only exists for the sync, and clear the URL out of `.git/config` when the run finishes.

## 6. Opening the pull request without an external CLI

PR mode (`--pr`) itself needs no external tool: the changes land on an automatically named branch, get pushed, and the comparison link is printed. But creating the PR in one step requires the matching command-line tool to be installed locally; without it you only get the link.

The next release intends to fall back to the platform API when no tool is installed, reusing the existing authentication configuration.

In the meantime: open the printed comparison link by hand, or install the command-line tool for your platform.

## 7. Asking about several paths at once

`why` accepts one path per run and answers whether that file will be synced this time and why (which ignore rule matched, whether it is already up to date, whether the delete policy kept it, whether it falls outside the gray selection, …). Batch investigation means running it file by file.

The next release intends to accept directories and multiple paths, and to group the answer by reason.

In the meantime: `status --json` carries a `plan.skipped` list per source, each entry with its `path` and an English `reason`, so grouping by `reason` with `jq` is far quicker than repeated `why` runs.

## 8. More notification channels

The available channels are `stdout`, `http`, `slack`, `dingtalk` and `wecom`. Feishu (Lark) has no built-in channel, so it has to be assembled through `http`, and the `http` channel cannot send custom signature headers either.

The next release intends to add a Feishu channel and custom headers plus signing for `http`.

In the meantime: point `http` at the Slack-compatible endpoint your platform offers, or convert on the receiving side.

## 9. Polling on a schedule without exposing a port

Automatic syncing today means either the webhook daemon (which needs a reachable port) or an external scheduler. A scheduled CI job is the usual substitute, but you have to write the workflow yourself.

The next release intends to ship a built-in poll mode (fetch upstream at an interval, exit quietly when nothing changed) together with a pipeline template you can copy as-is.

In the meantime: run `sync-upstream` from your OS scheduler or a CI cron job, with `--lock-wait` so it does not collide with a manual run.

## Related pages

- How far the current version goes: [Feature record](/en/features)
- Flags and fields: [CLI reference](/en/reference/cli) · [Configuration reference](/en/reference/configuration)
- Start here when something is wrong: [FAQ](/en/faq)
