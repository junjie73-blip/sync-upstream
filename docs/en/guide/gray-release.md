# Gray release and rollback

A gray release does the same thing twice: **it first trims the plan down to a subset and applies that, then applies the rest once validation passes**. It reuses the plain sync pipeline, swapping the plan for a canary plan and recording the stages in a state file.

## The minimal flow

```bash
# 1) Release 20% first (the CLI default for --percentage is already 20)
sync-upstream -gr --percentage 20 -V

# 2) After validation passes, release the rest
sync-upstream -gr --full-release

# Or, if something is wrong, go back to the state before the gray release
sync-upstream -gr --rollback
```

`-gr` only flips the switch on (equivalent to `grayReleaseConfig.enable: true`). The selection rules come from `--strategy` / `--percentage` / `--canary-dirs` / `--file-patterns`.

## Three selection strategies

| Strategy | Selection basis | Required field | Validation |
|---|---|---|---|
| `percentage` (default) | Deterministic bucketing by path: the same path always lands in the same bucket, and a bucket number `< percentage` is selected | `percentage` ∈ `(0, 100]` | Missing, non-numeric, or out of range fails immediately |
| `directory` | The sync directory the change belongs to matches `canaryDirs` by prefix | `canaryDirs` non-empty | An empty list fails immediately |
| `file` | The path matches `filePatterns` | `filePatterns` non-empty | An empty list fails immediately |

The matching rules in `file` mode are not glob — there are exactly three: a pattern containing `/` matches as a "path suffix" (a leading `/` may be omitted); `*.ext` matches as a file-name suffix; anything else must equal the file name exactly.

**Bucketing is deterministic**: rerunning the same plan selects the same batch of files, so what you did not release first can be released second without the canary set drifting.

## Stages

```
idle → canary → validating → completed
                           ↘ failed → (optional rollbackOnFailure) → rolled-back
```

| Stage | When it is entered | What happens |
|---|---|---|
| `canary` | Before the changes are applied | Writes `.sync-gray.json`: `releaseId`, the baseline commit `baseCommit`, and the canary and pending paths |
| `validating` | Once the changes are applied and validation starts | Runs the validation command if `validationScript` is configured (with retries and a timeout) |
| `completed` | Validation passed, or no validation configured | A full release clears the state file; a canary run keeps the pending list |
| `failed` | Validation failed | Records the error and writes an audit entry; rolls on to rollback if `rollbackOnFailure` is true |
| `rolled-back` | Rollback finished | Records the rollback commit |

Progress is computed from real numbers: `filesReleased / totalFiles`, and `completed` is fixed at 100%. The old version read a configuration key that did not exist, so it selected 0 files every time and progress stayed at 0%; the current behaviour is that **failing to select a canary is an error**:

```
灰度选择结果为空：当前计划没有任何文件落入金丝雀集合，请调整 percentage/canaryDirs/filePatterns
```

This message ("the gray release selection is empty: no file in the current plan falls into the canary set; adjust percentage/canaryDirs/filePatterns") is what the tool prints.

A `releaseId` looks like `md9k2z1-3f7a1c` (a base-36 timestamp plus 3 random bytes) and a new one is generated on every reselection.

## Configuration example

```json
{
  "grayReleaseConfig": {
    "enable": true,
    "strategy": "directory",
    "canaryDirs": ["packages/shared"],
    "validationScript": "pnpm typecheck",
    "maxRetries": 2,
    "rollbackOnFailure": true,
    "auditLogPath": ".sync-gray-audit.jsonl"
  }
}
```

How the validation command behaves: it runs in a shell at the repository root and fails on a non-zero exit code; a single attempt may run for at most 120 seconds before it is aborted; the total number of attempts is `maxRetries + 1` (`maxRetries` defaults to 0 when absent); output is kept to at most 4000 characters. A failure is a release verdict, not an exception, so it never interrupts the process.

An optional watchdog (started only when `enableMonitoring: true`):

```json
{
  "grayReleaseConfig": {
    "enable": true,
    "enableMonitoring": true,
    "monitorInterval": 5000,
    "alertThresholds": { "errorRate": 10, "maxExecutionTime": 300 }
  }
}
```

The watchdog never holds the process open, and it can be stopped explicitly. It **only prints a `[灰度告警]` warning ("gray release alert") and never decides that the release failed**; `alertThresholds.performanceDrop` has no effect today.

## What rollback actually does

`--rollback` uses the `baseCommit` recorded in `.sync-gray.json` to restore each "previously released path":

- Paths present in the baseline → checked out again from `baseCommit`
- Paths absent from the baseline (created by that release) → removed with `git rm`
- If the resulting diff is non-empty, one commit is created: `chore(sync): rollback gray release <releaseId>`

Rollback is skipped, with only the reason recorded, in three situations: `baseCommit` cannot be found (`找不到灰度起始版本，无法回滚` — "the gray release start revision cannot be found, rollback is impossible"), no released files were recorded, or the restored tree equals the start revision (`回滚未产生差异` — "the rollback produced no difference").

`--rollback` must be used together with `-gr`, because the rollback entry point lives in the gray release controller; running `sync-upstream -ro` alone reports `--rollback 需要同时启用 grayReleaseConfig` ("--rollback requires grayReleaseConfig to be enabled as well").

## Lifecycle

`.sync-gray.json` is deleted automatically only **when a full release succeeds**. After a canary run, a validation failure, or a rollback the file is kept, with the stage recorded as `canary` / `failed` / `rolled-back`, so the next `-gr` run continues from the same record (still requiring the repository, both branches, and the strategy to match).

`--full-release` and `--rollback` depend entirely on `.sync-gray.json` (which files are left, what they looked like before the release): if you delete it mid-release, the only way out is a manual `git revert` / `git checkout`. `.sync-gray-audit.jsonl` is just a record; losing it does not affect continuation. Field details and cleanup advice: [Runtime files and cleanup](/en/reference/configuration#runtime-files-and-cleanup).

## How it differs from a plain sync

| | Plain sync | Gray sync |
|---|---|---|
| Plan | The full plan | The subset selected by the strategy |
| Commits | One | One for the canary, another for the full release (rollback may add one more) |
| State | `.sync-state.json` | Plus `.sync-gray.json` and the audit log |
| Failure handling | Error and exit | Records the `failed` stage, optional automatic rollback |

## Related pages

- Flags: [CLI reference](/en/reference/cli) · [grayReleaseConfig in the configuration reference](/en/reference/configuration#grayreleaseconfig)
- When gray release and conflicts are both enabled: [Conflict handling](/en/guide/conflicts)
- Programmatic interface: [Gray release API](/en/reference/api#gray-release-api)
