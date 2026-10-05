# Conflict handling

A conflict is defined narrowly: **upstream wants to change this file, and you have also changed it locally (in the working tree)**. Conflicts are detected during the planning phase and resolved during the apply phase according to your strategy, so you never have to compare files by hand.

## Which conflicts are detected

There are 7 conflict types in total, but only the first 4 actually occur:

| Type | Trigger | Status |
|---|---|---|
| `content` | Upstream modifies the file and the file has uncommitted local changes | Occurs |
| `delete-modify` | Upstream deletes the file and you have modified it locally | Occurs |
| `untracked-overwrite` | Upstream adds the file and an untracked file exists at the same path in your working tree | Occurs |
| `type` | The same path is a file on one side and a directory on the other | Occurs |
| `add-add` | — | Reserved, never occurs (an untracked addition at the same path is handled as `untracked-overwrite`) |
| `symlink` | — | Reserved, never occurs (symlink differences are handled as `content`) |
| `unreadable` | — | Reserved, never occurs (an unreadable file is treated as "this file does not exist on that side") |

When the target branch and upstream share no common history, auto-merge cannot tell which side is the "original", so both sides are treated as modified and conflict markers appear more often.

## The five strategies

```bash
sync-upstream --conflict-strategy prompt-user   # ask per file (default)
sync-upstream --conflict-strategy use-source    # always take upstream
sync-upstream --conflict-strategy keep-target   # always keep local
sync-upstream --conflict-strategy auto-merge    # three-way merge; write conflict markers when it cannot merge
sync-upstream --conflict-strategy skip          # skip conflicted files
```

| Strategy | Resulting action | Notes |
|---|---|---|
| `prompt-user` | Depends on your choice | Each conflicted file is asked about at most once; no choice or `Ctrl+C` is treated as keep local, and the prompt is never repeated |
| `use-source` | `take-upstream` | Overwrite directly with the upstream content |
| `keep-target` | `keep-local` | Keep the local version; the apply phase records this as "keep local" — nothing is written and nothing is deleted |
| `auto-merge` | `take-upstream` / `keep-local` / `write-merged` / `skip` | See the next section |
| `skip` | `skip` | Leave the whole file untouched |

An invalid strategy value (for example a typo in `keep-target`) aborts the entire run with an error (exit code 2) instead of silently falling back to the default.

## How auto-merge works

For text files, auto-merge performs a line-level three-way merge: it compares your current local content, the upstream content, and the common historical version of the two.

| Case | Outcome |
|---|---|
| Both sides match, or only one side changed | The changed side is taken automatically |
| Both sides changed and touched the same region | Standard conflict markers are written (the log reports the number of conflict hunks) |
| One side deleted, the other modified | Standard conflict markers are written |
| Both sides deleted | The file is skipped |
| Either side is a binary file | The file is skipped (`二进制文件无法自动合并` — "binary files cannot be auto-merged") |

Conflict markers look like this; the file is **written and staged with the markers still in it**, and you resolve it by hand before committing:

```text
<<<<<<< LOCAL
your version
=======
upstream version
>>>>>>> UPSTREAM
```

Auto-merge has large-file protection: if any version involved in the merge exceeds about 20 000 lines, or the differing region is too large, line-by-line merging is skipped and conflict markers wrapping the whole file are written instead, so you never wait on a long stall.

## Silencing prompts by extension

To avoid downgrading the strategy globally, use `autoResolveTypes` to keep specific extensions **out of the prompts**:

```json
{
  "conflictResolutionConfig": {
    "defaultStrategy": "prompt-user",
    "autoResolveTypes": [".md"],
    "logResolutions": true
  }
}
```

Mind the semantics: under `prompt-user`, files matching `autoResolveTypes` are **kept local** (the conservative choice) — they are not auto-merged. If you want "auto-merge these extensions", set `defaultStrategy` to `auto-merge`.

`logResolutions` is on by default and logs each decision at debug level as `冲突已解决: <path> → <action>` ("conflict resolved: `<path>` → `<action>`"); `-V` shows everything. The `resolutionLogFile` option currently has no effect (no separate decision log file is written).

## One bad file does not block the batch

If a conflicted file fails while being read or merged, it is only recorded as `skip` with a reason (`处理失败: <message>` — "processing failed: `<message>`"), and the other conflicts in the same batch keep being processed. The single exception is an invalid strategy value — that is a configuration error, so the whole run must fail.

## Behaviour without a terminal

With `-y` and `defaultStrategy` set to `prompt-user`, a warning is printed before the run and the strategy is changed to `keep-target`:

```text
 WARN  Non-interactive mode: 2 conflicted file(s) resolved as keep local (set conflictResolutionConfig.defaultStrategy to change this behaviour)
```

In CI it is more common to state the strategy explicitly:

```bash
sync-upstream -y --conflict-strategy auto-merge
```

## Related pages

- Programmatic interface: [Conflict API](/en/reference/api#conflict-api)
- Field reference: [conflictResolutionConfig in the configuration reference](/en/reference/configuration)
