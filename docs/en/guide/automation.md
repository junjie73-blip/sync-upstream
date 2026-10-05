# CI and automation

The four things you need to script this tool: how to stop it asking questions, how to read exit codes, how to read logs, and how to retry after a failure.

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

- **`-y` only guarantees zero prompts when the configuration is complete**: if `upstreamRepo` or `syncDirs` is missing, the run still falls into interactive completion, so in CI always supply them through a config file or `-r`/`-d`
- Credentials must be expanded by CI into flags or written into a generated configuration file — the tool reads no environment variables
- Pass `--conflict-strategy` explicitly instead of relying on `-y` to downgrade `prompt-user` to keep local
- Run `-P -V` once first to put the plan into the log, then run the real sync; when something goes wrong the logs line up

To only check "is there anything new upstream" without applying it, combine a preview with a plan count:

```bash
npx sync-upstream -C sync-upstream.config.json -y -P | tee sync-plan.txt
grep -q "计划: 0 项变更" sync-plan.txt && echo "up to date"
```

The grep pattern must match the plan summary exactly as the tool prints it: `计划: 0 项变更` means "plan: 0 changes".

## Exit codes

| Code | Meaning | Suggested handling |
|---|---|---|
| 0 | Success (including "nothing to commit", preview runs, and interactive cancellation) | Continue |
| 1 | Unexpected error, or some files failed to apply | Look for the `x <path>` lines in the log |
| 2 | Configuration/validation failure, unknown command-line flag | Fix the configuration or the flags |
| 3 | Git operation failed (fetch, checkout, push, missing ref, missing branch) | Check credentials and branches |
| 4 | Cancelled by the user | Reserved: interactive cancellation currently ends with 0 and never returns 4 |

Exit codes are mapped from the error category: configuration and command-line problems → 2, git operation failures → 3, everything else (authentication failures, network jitter, timeouts, unexpected errors) → 1. Partial apply failures are not an exception but a result check: as soon as any path fails to apply, the exit code is 1.

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

## Concurrency and retries

Two numbers govern two different things and are easy to confuse:

| Configuration | Default | Actual scope |
|---|---|---|
| `concurrencyLimit` (`--concurrency`) | 10 | Applies **only** when a batch of paths fails to apply and the tool falls back to retrying them one by one: the maximum number of paths handled at the same time, where one failure does not affect the others. When the batch succeeds in one go, concurrency is not involved |
| `retryConfig` (`--retry-max` / `--retry-delay` / `--retry-backoff`) | 3 attempts / 2000ms / 1.5 | Covers **only** the "fetch the upstream branch" step, and retries only failures that look like network problems |

The retry delay is `initialDelay × backoffFactor^(n-1)` (rounded to milliseconds); a failure is retried only when its message carries network-like wording (`网络`, `network`, `connect`, `resolve host`, `timed out`, `timeout`, `RPC failed`, `early EOF`, `The remote end`). Non-network failures (authentication failures, missing branches) fail on the first attempt instead of wasting retries. Once retries are exhausted the failure is reported as-is; the message contains `超时` ("timed out") or network wording, and the exit code is 1 either way.

Applying files, deleting, committing, and pushing are never retried automatically — their failures are either immediately decidable or need a human. When a push fails, the commit already exists locally, so rerunning or pushing manually with `git push` both work.

## Retrying cleanly after a failure

```bash
git status --short             # inspect the current working tree
git log --oneline -3           # check whether anything was already committed
rm -f .sync-state.json         # drop the "already synced" record so the next run compares everything
rm -f .sync-gray.json .sync-gray-audit.jsonl   # delete only if you no longer need to roll back the gray release
```

What the tool leaves behind is bounded: three state files, one remote named `sync-upstream`, and some commits on the target branch. `origin` is never rewritten, and nothing outside the sync directories is touched. How to read specific errors: [Troubleshooting in the FAQ](/en/faq#troubleshooting).

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
