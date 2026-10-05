# sync-upstream

🚀 **Directory-scoped upstream sync for forks**

Sync the few directories you actually care about from an upstream repository into your own branch — previewably, auditably, reversibly — without touching anything else.

[简体中文](README.md) | English · Docs site: [usage guide](https://flow-zy.github.io/sync-upstream/) (中文 / English)

---

## Why this exists

When you maintain a fork, `git merge upstream/main` pulls in **everything** the upstream changed, while in practice you usually only want to follow `src/config` and `packages/utils`:

- Copying files by hand misses things, overwrites local customisations, and leaves no audit trail
- Syncing through a throwaway branch and a scratch directory leaves dirty state behind when it is interrupted
- The preview says 100 files changed, the commit contains 98, and nobody can explain the difference
- Conflicts are eyeballed one by one, with no "keep mine / take upstream / three-way merge" choice

sync-upstream makes three promises: **it only touches the paths you list**, **every line the preview prints is a line in the commit**, and **no throwaway branches, no scratch directories — if it is interrupted, just run it again**.

If you are wondering "GitHub / Gitee have a one-click Fetch upstream, why install anything", read [vs. built-in fork sync](docs/en/guide/vs-fork-sync.md) — it walks through concrete examples and is honest about when this tool is the wrong choice.

> Before you start: the current directory must already be a Git repository (`git init` is enough) and the target branch must exist.

---

## What it does

### Syncing
- **Directory-scoped**: only the paths in `syncDirs` are synced (a directory or a single file both work); everything else is never read, modified or committed
- **The preview is the result**: `-P` / `-n` lists every path to be added / modified / deleted without touching the working tree, switching branches or committing (it still fetches upstream, so it fails offline)
- **Incremental runs**: `--incremental` skips content already synced last time and only handles what changed since; `--force` ignores that baseline and compares in full
- **Contained failures**: files are applied in batches; one failing file is marked with its reason and the rest still complete — fix the cause and run again
- **Dedicated remote**: upstream is fetched through a remote named `sync-upstream`; your `origin` is never rewritten

### Conflicts
- Four conflict classes are detected: both sides edited content (`content`), one side deleted while the other edited (`delete-modify`), an untracked local file would be overwritten (`untracked-overwrite`), file vs directory with the same name (`type`)
- Five strategies: `use-source`, `keep-target`, `auto-merge`, `prompt-user`, `skip`
- `auto-merge` attempts to merge both sides line by line; when it cannot, it writes conflict markers instead of silently dropping your changes
- Binary files and very large text files are not auto-merged; they are skipped on their own, without affecting the rest of the batch

### Release control
- **Gray release**: ship a first batch selected by percentage / directory / file pattern; the same percentage selects the same batch on a re-run
- **One-shot full release / rollback**: `--full-release` ships the remaining files; `--rollback` restores what was already released — as a new rollback commit, never by rewriting pushed history
- **Audit trail**: stage transitions are appended to `.sync-gray-audit.jsonl`, and the path is configurable

### Configuration and errors
- **Multiple formats**: JSON / JSON5 / YAML / TOML, auto-discovered across 16 candidate filenames, or point at one explicitly with `-C`
- **Fails loudly**: a config file that cannot be read, is malformed or is not an object aborts the run with the failure reason per format — never a silent fallback to defaults
- **Aggregated validation**: all configuration problems are reported at once (wrong types, illegal paths, misspelled enums, out-of-range values), with warnings for alias keys and unrecognised keys
- **Predictable exit codes**: 0 success / 1 a file failed or something unexpected / 2 configuration or argument problem / 3 git failure (4 is reserved)
- **Webhook daemon**: GitHub / GitLab / Bitbucket / Gitea with signature or token verification, IP allowlist, per-IP rate limiting and a 1 MiB body cap

---

## Up and running in 30 seconds

```bash
npm install -g sync-upstream

cd /path/to/your-repo
sync-upstream --generate-config          # writes sync-upstream.config.json
# edit upstreamRepo / syncDirs / companyBranch
sync-upstream --preview-only --verbose   # look at the plan first
sync-upstream                            # then run it for real
```

You can also run with no configuration file; the tool asks for whatever is missing:

```bash
sync-upstream -r https://github.com/vuejs/core.git -d packages/runtime-core -b main -c company/main
```

In scripts and CI, `-y` suppresses the questions (the configuration must be complete — `upstreamRepo` and a non-empty `syncDirs`, otherwise the completion prompts still run):

```bash
sync-upstream -C sync-upstream.config.json -y --push
```

---

## Configuration example

`sync-upstream.config.json` (these are the canonical key names; legacy aliases are still recognised but warn once):

```json
{
  "upstreamRepo": "https://github.com/vuejs/core.git",
  "upstreamBranch": "main",
  "companyBranch": "company/main",
  "syncDirs": ["packages/runtime-core", "packages/shared"],
  "commitMessage": "chore(sync): sync runtime-core from upstream",
  "ignorePatterns": ["**/__tests__/**", "*.log"],
  "includeFileTypes": [".ts", ".vue"],
  "concurrencyLimit": 10,
  "forceOverwrite": true,
  "autoPush": false,
  "verbose": false,
  "retryConfig": {
    "maxRetries": 3,
    "initialDelay": 2000,
    "backoffFactor": 1.5
  },
  "conflictResolutionConfig": {
    "defaultStrategy": "prompt-user",
    "autoResolveTypes": [".md"],
    "logResolutions": true
  },
  "authConfig": {
    "type": "pat",
    "username": "git",
    "token": "read-from-env-or-credential-helper"
  }
}
```

YAML / TOML / JSON5 use exactly the same keys; see the [configuration guide](docs/en/guide/configuration.md) for a `.yaml` version.

---

## CLI cheat sheet

For full semantics (where each default comes from, flag group boundaries, the config key each flag writes) see the [CLI reference](docs/en/reference/cli.md); this table is a quick lookup.

| Flag | Alias | Type | Meaning |
|---|---|---|---|
| `--repo` | `-r` | `<url>` | Upstream repository URL |
| `--branch` | `-b` | `<branch>` | Upstream branch (default `main`) |
| `--company-branch` | `-c` | `<branch>` | Target branch (default `main`) |
| `--dirs` | `-d` | `<a,b>` | Sync paths (directory or single file), comma separated |
| `--message` | `-m` | `<text>` | Commit message |
| `--push` | `-p` | flag | Push after committing |
| `--force` | `-f` | flag | Apply everything in the plan, ignoring the incremental baseline |
| `--incremental` | | flag | Apply only what changed since the last sync (`forceOverwrite: false`) |
| `--preview-only` | `-P` | flag | Print the plan only; change nothing |
| `--dry-run` | `-n` | flag | Same as `--preview-only`, for scripts |
| `--config` | `-C` | `<path>` | Explicit config file; a read failure is an error |
| `--config-format` | `-F` | `<fmt>` | `json` (default) / `json5` / `yaml` / `toml`, used by `-g` |
| `--generate-config` | `-g` | flag | Write a default config file and exit |
| `--non-interactive` | `-y` | flag | Ask nothing (still prompts if the config is incomplete); `prompt-user` conflicts fall back to keeping local |
| `--ignore` | | `<a,b>` | Extra ignore rules (gitignore syntax) |
| `--include-types` | | `<a,b>` | Only sync these extensions, e.g. `.ts,.vue` |
| `--conflict-strategy` | | `<s>` | `use-source` / `keep-target` / `auto-merge` / `prompt-user` / `skip` |
| `--retry-max` | | `<n>` | Max retries for network-class failures |
| `--retry-delay` | | `<ms>` | Initial retry delay |
| `--retry-backoff` | | `<factor>` | Backoff factor |
| `--concurrency` | | `<n>` | Concurrency for the per-path retry pass after a batch fails |
| `--gray-release` | `-gr` | flag | Enable gray release |
| `--strategy` | | `<s>` | Selection strategy: `percentage` (default) / `directory` / `file` |
| `--percentage` | | `<n>` | Gray release percentage in `(0, 100]`, CLI default 20 |
| `--canary-dirs` | | `<a,b>` | Canary directories for the `directory` strategy |
| `--file-patterns` | | `<a,b>` | File patterns for the `file` strategy |
| `--validation-script` | | `<cmd>` | Validation command; a non-zero exit means validation failed |
| `--full-release` | `-fr` | flag | Release the files left over from the gray stage |
| `--rollback` | `-ro` | flag | Roll back the release recorded in `.sync-gray.json` |
| `--auth-type` | | `<t>` | `ssh` / `pat` / `user_pass` |
| `--auth-username` / `--auth-token` / `--auth-password` / `--auth-key` | | `<value>` | The matching credentials |
| `--webhook-enable` | `-we` | flag | Run as a webhook daemon |
| `--webhook-port` | | `<n>` | Listen port (default 3000) |
| `--webhook-path` | | `<path>` | Callback path (default `/webhook`) |
| `--webhook-secret` | | `<secret>` | Signature secret; an empty secret rejects every request |
| `--webhook-events` | | `<a,b>` | Accepted events (default `push`) |
| `--webhook-branch` | | `<branch>` | Branch that triggers a sync (default `main`) |
| `--verbose` | `-V` | flag | Verbose logging plus the complete change list (does not enable debug) |
| `--silent` | `-s` | flag | Errors only |
| `--version` | `-v` | flag | Print the version |
| `--help` | `-h` | flag | Print help |

Unrecognised flags are rejected (exit code 2) with a pointer to `--help`; they are never ignored.

---

## What it touches while running

| Object | Location | Notes |
|---|---|---|
| `.sync-state.json` | repository root | The incremental baseline; invalidated and rebuilt when the upstream repository or branch changes, safe to delete |
| `.sync-gray.json` | repository root | Gray release progress; **do not delete mid-release**, it is removed automatically after a successful full release |
| `.sync-gray-audit.jsonl` | repository root | Gray release audit log, record only; relocatable via `grayReleaseConfig.auditLogPath` |
| remote `sync-upstream` | `.git/config` | Dedicated upstream remote; does not affect `origin` and can be removed with `git remote remove` any time |
| commits | target branch | Contain only the paths applied in that run; unrelated dirty files are never swept in |

Built-in ignore rules keep `.sync-state.json` (and the legacy `.sync-cache/`, `.sync-temp/`, `.sync-hashes.json`) out of every plan; **the two gray files are not in that list**, so exclude them manually if you sync the repository root. With `pat` / `user_pass` authentication the remote URL carries your credentials — never paste `.git/config` into logs or issues (URLs in the tool's own output are redacted). Details in [runtime files and cleanup](docs/en/reference/configuration.md#runtime-files-and-cleanup).

Note that log and error messages are emitted in Chinese; the docs quote them verbatim so you can match your own output.

---

## Troubleshooting at a glance

| Symptom | Cause and fix |
|---|---|
| `Not a git repository` | The current directory is not a Git repository: `git init`, then retry |
| `` `配置文件不存在: ...` `` (config file not found) | The `-C` path does not exist; there is no fallback to defaults, fix the path |
| `` `配置文件 x.json 解析失败` `` (parse failure) | The message lists why each format failed; fix the syntax accordingly |
| `` `配置校验失败: - ...` `` (validation failed) | Everything wrong is listed at once; fix `upstreamRepo` / `syncDirs` / enum values as indicated |
| `` `目标分支 x 既不在本地也不在 origin` `` (branch neither local nor on origin) | Preview will not create branches; check the name with `git branch -r` |
| `` `推送到 origin/xxx 失败` `` (push failed) | Check credentials and branch protection; the commit exists locally, `git push` works on its own |
| The plan is empty but you expected changes | The previous run already synced it; use `--force` to ignore `.sync-state.json` and compare in full |

Log levels and exit codes are covered in the [FAQ](docs/en/faq.md); every field is in the [configuration reference](docs/en/reference/configuration.md).

---

## Documentation map

The docs site is a **usage guide only**: installation, operations, configuration, troubleshooting. Internal architecture and implementation notes are deliberately not part of it. Preview locally with `pnpm docs:dev`.

| Section | Pages | Covers |
|---|---|---|
| Choosing | [vs. built-in fork sync](docs/en/guide/vs-fork-sync.md) | When "Fetch upstream" is enough, when you need this tool |
| Getting started | [Quick start](docs/en/guide/quick-start.md) · [Installation](docs/en/guide/installation.md) · [Configuration file](docs/en/guide/configuration.md) | Requirements, install, generating and filling your first config |
| Using | [Overview](docs/en/guide/usage.md) | What happens in one run and where to go next |
| Using | [Everyday sync](docs/en/guide/sync-basics.md) | Preview, prompts, apply and commit boundaries, branch strategy |
| Using | [Conflicts](docs/en/guide/conflicts.md) | Four conflict classes, five strategies, limits of auto-merge |
| Using | [Gray release and rollback](docs/en/guide/gray-release.md) | Selection strategies, stages and state, validation, rollback |
| Using | [Webhook daemon](docs/en/guide/webhook.md) | Request handling order and status codes, signatures, event filters |
| Using | [CI and automation](docs/en/guide/automation.md) | Non-interactive runs, exit codes, logging, concurrency and retries |
| Reference | [CLI](docs/en/reference/cli.md) · [Configuration](docs/en/reference/configuration.md) · [API](docs/en/reference/api.md) | Every flag, field and programmatic entry point |
| Project | [Features](docs/en/features.md) · [FAQ](docs/en/faq.md) · [Changelog](docs/en/changelog.md) | Capabilities and limits, troubleshooting, change history |

- 中文文档：[docs/](docs/) · [README.md](README.md)
- Release history: [CHANGELOG.md](CHANGELOG.md)
- Requirements: Node.js ≥ 18.2, Git ≥ 2.25
- Development: `pnpm install` → `pnpm test` → `pnpm build`; issues and PRs welcome — please pass `pnpm lint && pnpm test` first and describe the behaviour change

---

License: MIT
