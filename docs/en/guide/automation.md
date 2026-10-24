# CI and automation

What you need to script this tool: how to stop it asking questions, how to read the exit codes and the machine output, where the logs go, how to retry after a failure, and how the notifications get out.

## Running in CI

```yaml
- name: Sync upstream
  env:
    UPSTREAM_TOKEN: ${{ secrets.UPSTREAM_READ_TOKEN }}
  run: |
    npx sync-upstream -C sync-upstream.config.json -y \
      --auth-type pat --auth-token "$UPSTREAM_TOKEN" \
      --conflict-strategy keep-target
```

Key points:

- **`-y` only guarantees zero prompts when the configuration is complete**: if `upstreamRepo` or `syncDirs` is missing the run still falls into interactive completion, so in CI always supply them through a config file or `-r` / `-d`
- Credentials have to be expanded by CI into flags or written into a generated configuration file — the tool only reads these environment variables: `SYNC_UPSTREAM_LANG`, `LC_ALL`, `LANG`, `LANGUAGE` (which decide the output language), `GITHUB_STEP_SUMMARY` (where the CI summary is written) and `SYNC_UPSTREAM_PR_CREATE=0` (skip creating the pull request); it never reads a credential from an environment variable
- Pass `--conflict-strategy` explicitly instead of relying on `-y` to downgrade `prompt-user` to keep local
- Run `-P -V` once first to put the plan into the log, then run the real sync; when something goes wrong the logs line up
- `init` needs an interactive terminal: it is refused when `--json` is given, when `-y` is given, or when there is no tty at all (which is exactly what CI looks like), with exit code 2, and it tells you to generate a template with `--generate-config` and edit that instead
- Leave yourself a way out when a scheduled job and CI can overlap: a run that cannot take the repository lock fails immediately (exit code 5), so add `--lock-wait` if you want it to queue — see [Concurrency and retries](#concurrency-and-retries)

To only check "is there anything new upstream" without applying it, combine a preview with a plan count:

```bash
npx sync-upstream -C sync-upstream.config.json -y -P | tee sync-plan.txt
grep -q "计划: 0 项变更" sync-plan.txt && echo "up to date"
```

The `grep` pattern has to match the plan line exactly as the tool prints it, and by default that line is Chinese: `计划: 0 项变更` means "plan: 0 changes", while `--lang en` prints `Plan: 0 changes`. The read-only subcommands are less effort: `sync-upstream status --json` gives the count of pending changes and `sync-upstream doctor --json` gives a configuration and environment check, and neither one touches the working tree.

## Machine-readable output

```bash
sync-upstream --json -y        # stdout is a single JSON document
sync-upstream status --json
sync-upstream why packages/shared/src/const.ts --json
sync-upstream doctor --json
sync-upstream history --limit 50 --json
```

- stdout holds **one complete JSON document** (not a stream of lines), with colour codes stripped, so you can pipe it straight into `| jq`
- `--json` pushes the console log down to error level, because otherwise log lines would end up in the pipe; what you want to read is the errors and the `warnings` inside the report
- the top level is always `command` / `ok` / `exitCode` / `generatedAt` / `data` / `warnings` (a sync run and an undo add `summary`), field by field in the [CLI reference](/en/reference/cli)
- under `--json` nothing is ever asked: `deletePolicy: ask` keeps the files, and a `prompt-user` conflict is resolved as "keep local"
- in GitHub Actions a sync plus `status` and `doctor` append the same content to `$GITHUB_STEP_SUMMARY` as markdown, so no extra step is needed; if that write fails you only get one more warning, and the exit code is unaffected

```bash
sync-upstream --json -y | jq -r '.data.commit.hash // "no commit"'
```

## Exit codes

| Code | Meaning | Suggested handling |
|---|---|---|
| 0 | Success (including "nothing to commit", preview runs, and cancelling inside a sync — that is handled as keep-local and still finishes at 0) | Continue |
| 1 | Unexpected error, or some files failed to apply; `--undo` found nothing to undo | Look for the `x <path>` lines in the log |
| 2 | Configuration/validation failure, unknown command-line flag, `init` without a terminal, or a gray release combined with multiple upstreams | Fix the configuration or the flags |
| 3 | Git operation failed (fetch, checkout, push, missing ref, missing branch) | Check credentials and branches |
| 4 | Cancelled by the user, which today means cancelling the `sync-upstream init` questionnaire (`Ctrl+C` or choosing cancel) | Treat it as abandoning that init run; a cancellation inside a sync never reaches here |
| 5 | The repository lock is held by another sync (`--lock-wait` timed out as well) | Move the schedules apart, or give the cron job `--lock-wait` |

Exit codes are mapped from the error category: configuration and command-line problems → 2, git operation failures → 3, an unavailable repository lock → 5, and everything else (authentication failures, network jitter, timeouts, unexpected errors) → 1. Partial apply failures are not an exception but a result check: as soon as any path fails to apply, the exit code is 1.

## Logging

```bash
sync-upstream -V    # raise the log level and list the full change set
sync-upstream -s    # keep error output only
```

| Flag | Log level | Plan listing |
|---|---|---|
| Default | info / success / warn / error | First 40 entries, the remainder summarized by `完整列表见 --verbose` ("full list available with --verbose") |
| `-V` / `--verbose` | Adds verbose | Every path |
| `-s` / `--silent` | Errors only | Not printed |

Two points that are easy to misread:

- **`-V` does not enable debug.** Debug is currently used only for the per-file line `冲突已解决: 路径 → 动作` ("conflict resolved: `<path>` → `<action>`"), and no command-line flag lowers the level to debug; it is only reachable when the tool is used as a library (see the [API reference](/en/reference/api)).
- **The plan entry limit comes from `verbose` in the configuration, while the log level comes from the command line.** So `"verbose": true` in the configuration file makes the plan print every path but leaves the level at info; conversely `-V` sets both.

When `-V` and `-s` are given together, `-V` wins. Under `-s`, errors and failed paths are still printed while all progress information is silenced, which suits scripted capture. The configuration summary (upstream, branches, sync directories, retries, conflict strategy, and so on) is printed at info level, so it does not appear under `-s`.

## Log files and rotation

A daemon, or a CI runner that is reused, needs to leave a trace, and that is what `logConfig` (`--log-file`) is for: every log line goes to the terminal and is appended to a file at the same time.

```bash
sync-upstream --log-file logs/sync.log --log-level info --log-max 2097152 --log-keep 10
sync-upstream --log-file sync.jsonl --log-json    # one JSON object per line, easy to ingest
```

- `--log-file` is the switch: without it only the terminal gets output (which is all that 0.2 and earlier did); a relative path resolves against the current working directory, and missing directories are created for you
- `--log-level` only concerns the file side and accepts `debug` / `info` / `warn` / `error`, default `info`; the terminal level is still set by `-V` / `-s`
- **The file is not affected by `-s`**: `--silent` means "do not flood my output", not "do not keep a record" — otherwise a daemon that died at 3 a.m. and a daemon that never started would look identical in the logs
- Rotation is triggered by size: 5 MiB per file by default (`--log-max`), and when a file fills up `<file>` becomes `<file>.1`, `<file>.1` becomes `<file>.2`, and so on, with the file beyond the oldest `--log-keep` (default 5) copies discarded; `--log-keep 0` keeps no history and starts the file over
- Colour codes and credentials are removed before anything is written: user names and passwords inside URLs, `token=`, and `Bearer …` are all masked, as are the webhook secret and every string listed in `logConfig.redact`
- A log file that cannot be written prints `[LOG] 写入日志文件 … 失败: …` ("failed to write the log file ...") to stderr once and changes neither the sync result nor the exit code

`--log-json` and `--json` are two different things: the first decides what the file on disk looks like, the second decides whether stdout is one JSON report.

## Notification hooks

With `notifyConfig.enable` on, the outcome of a sync is pushed to a chat tool or an HTTP endpoint. The events you care about by default are `success`, `conflict`, `failure` and `undo`; an empty run (plan of 0) is deliberately **not** announced by default, because a daemon on a busy repository would otherwise send a message for every push.

```json
{
  "notifyConfig": {
    "enable": true,
    "channels": ["slack", "dingtalk"],
    "slackUrl": "https://hooks.slack.com/services/xxx",
    "dingtalkUrl": "https://oapi.dingtalk.com/robot/send?access_token=xxx",
    "dingtalkSecret": "SEC...",
    "events": ["success", "conflict", "failure"]
  }
}
```

```bash
sync-upstream --notify stdout            # only log what the notification would say, to see the shape
sync-upstream --notify http --notify-url https://example.com/hook
sync-upstream --notify-events success,failure
sync-upstream -y --no-notify             # send nothing at all in this run
```

- the channels are `stdout`, `http`, `slack`, `dingtalk` and `wecom`; a channel whose URL is missing is skipped, which is not an error
- bot addresses are credentials: put them in the config file or in a config file CI generated, never on the command line (`--notify-url`, meant for wiring one temporary CI callback, is the exception)
- a DingTalk bot with signing enabled but no `dingtalkSecret` in the config refuses the delivery, and the tool warns about that first
- each request times out after 5000ms by default (`timeoutMs`), each channel tries twice in total by default (`retries`), and the gap between the two attempts comes from `notifyConfig.retryConfig.initialDelay`, 500ms when you do not set it (note this is not the top-level sync `retryConfig`, whose default is 2000ms); a provider being down leaves one `通知 slack 失败: …` ("slack notification failed: ...") line in the log and changes neither the sync result nor the exit code
- `template` customizes the wording, with the placeholders `{outcome}` `{upstream}` `{upstreamBranch}` `{companyBranch}` `{commit}` `{files}` `{kept}` `{conflicts}` `{skipped}` `{error}` `{duration}`; `includeDetails: false` drops the per-file summary and the notification carries only a handful of example paths
- a preview run never notifies, and a daemon that retries three times announces only the final attempt

## Concurrency and retries

Three numbers govern three different things and are easy to confuse:

| Configuration | Default | Actual scope |
|---|---|---|
| `concurrencyLimit` (`--concurrency`) | 10 | Applies **only** when a batch of paths fails to apply and the tool falls back to retrying them one by one: the maximum number of paths handled at the same time, where one failure does not affect the others. When the batch succeeds in one go, concurrency is not involved |
| `retryConfig` (`--retry-max` / `--retry-delay` / `--retry-backoff`) | 3 attempts / 2000ms / 1.5 | Covers **only** the "fetch the upstream branch" step, and retries only failures that look like network problems |
| `lockWaitMs` (`--lock-wait`) | `0` | How many milliseconds to wait for another run to release the repository lock; `0` means it fails as soon as the lock is taken (exit code 5). This one is about "only one sync per working tree at a time" and has nothing to do with the two rows above |

The retry delay is `initialDelay × backoffFactor^(n-1)` (rounded to milliseconds); a failure is retried only when its message carries network-like wording (`网络`, `network`, `connect`, `resolve host`, `timed out`, `timeout`, `reset`, `closed`, `RPC failed`, `early EOF`, `无法访问`, `不可达`). The Chinese alternatives are there because the tool's own Chinese diagnostics contain them. Non-network failures (authentication failures, missing branches) fail on the first attempt instead of wasting retries. Once retries are exhausted the failure is reported as-is; the message contains `超时` ("timed out") or network wording, and the exit code is 1 either way.

Applying files, deleting, committing, and pushing are never retried automatically — their failures are either immediately decidable or need a human. When a push fails, the commit already exists locally, so rerunning or pushing manually with `git push` both work.

### Repository lock and scheduled runs

When cron and a webhook collide you do not get two errors, you get two interleaved commits, so every run — previews included — takes `.git/sync-upstream.lock` for itself:

- the default is `lockWaitMs: 0`, so a run that cannot get the lock fails with exit code 5. In a scheduled job give `--lock-wait` something close to how long the run takes, for instance `--lock-wait 300000`; while waiting the lock is retried every 200ms
- a lock whose owning process has exited, or whose age exceeds 30 minutes, is taken over automatically with a `发现过期锁…接管` ("stale lock found ... taking over") warning, so a crash needs no manual cleanup — unless the lock is younger than 30 minutes and you know for certain the other side is dead
- the daemon's delivery queue is serialized inside its own process (see [webhook daemon](/en/guide/webhook)); across processes and across machines this lock is the only thing standing between them
- the lock does not solve "two runners pushing the same branch": that needs a concurrency group on the CI side, or schedules that do not overlap

## Retrying cleanly after a failure

```bash
git status --short             # inspect the current working tree
git log --oneline -3           # check whether anything was already committed
sync-upstream history          # the sync commits this tool recorded
sync-upstream --undo           # the last sync was a commit, so undo it
rm -f .sync-state.json         # drop the "already synced" record so the next run compares everything
rm -f .sync-gray.json .sync-gray-audit.jsonl   # delete only if you no longer need to roll back the gray release
```

Touch the state files only after `--undo` — or after it refuses because HEAD has moved on and you ran `git revert` yourself. What the tool leaves behind is bounded: the state files (with multiple upstreams each source has its own `.sync-state-*.json`), the sync history, a remote named `sync-upstream` (plus `sync-upstream-2` and onward when there are several), some commits on the target branch, `.git/sync-upstream.lock`, and optionally a log file and the webhook delivery log. `origin` is never rewritten, and nothing outside the sync directories is touched. How to read a specific error message: [Troubleshooting in the FAQ](/en/faq#troubleshooting).

## Single files and partial scopes

`syncDirs` accepts file paths directly (`["package.json"]`) as well as "directory + filter":

```json
{
  "syncDirs": ["packages/shared"],
  "includeFileTypes": [".ts"],
  "ignorePatterns": ["**/__tests__/**", "**/*.spec.ts"]
}
```

Evaluation order matches gitignore: the last match wins. Layering and interpretation of ignore rules: [Configuration file](/en/guide/configuration#where-ignore-rules-live).

## Related pages

- [CLI reference](/en/reference/cli) · [Configuration reference](/en/reference/configuration)
- [Usage overview](/en/guide/usage): why the preview always matches what gets committed
- [Runtime files and cleanup](/en/reference/configuration#runtime-files-and-cleanup): which files are safe to delete
- [Everyday sync -> One sync at a time per repository](/en/guide/sync-basics#one-sync-at-a-time-per-repository) · [Undo the last sync](/en/guide/sync-basics#undo-the-last-sync)
- [Webhook daemon](/en/guide/webhook): the daemon's queue, rate limit, and delivery log
