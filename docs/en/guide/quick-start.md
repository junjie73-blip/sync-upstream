# Quick start

Goal: once it is installed, first ask "what state am I in right now", then preview, then sync. Nothing outside the directories you name gets touched.

## Prerequisites

| Item | Requirement |
|---|---|
| Node.js | >= 18.2 |
| Git | >= 2.25 |
| Current directory | A repository you already ran `git init` in (the tool never initialises one for you) |
| Target branch | Already exists (locally or on `origin`); preview mode never creates branches |

Check your versions:

```bash
node -v
git --version
sync-upstream --version
```

## 1. Install

```bash
npm install -g sync-upstream        # global install, gives you the sync-upstream command
# or skip installing and run it straight from the repository:
npx sync-upstream --help
```

Details in the [installation guide](/en/guide/installation).

## 2. Answer a few questions to get a config

The first time round you do not have to work down a field table: `init` asks only the few things you actually need to decide.

```bash
cd /path/to/your-repo
sync-upstream init
```

The questions come in this order: file format, upstream repository, sync directories (comma separated), the upstream ref (a branch, a tag or a commit id all work), target branch, commit message, what to do with local files that upstream deleted (`mirror`/`keep`/`ask`), how to handle conflicts, and whether to push automatically once the sync is done. When it finishes it prints `配置已写入 <绝对路径>` ("config written to `<absolute path>`"), and pressing Enter on an empty line takes the default shown in parentheses.

- Only the fields you answered are written; everything else falls back to a built-in default, so the file stays small enough to read in one glance
- Before it writes anything, the result is validated with the rules a real run uses, so `init` cannot hand you a file that the next run refuses to load
- If the target file already exists, overwriting it takes `-f`: `sync-upstream init -f`
- `-C` says which file to write and `-F` says which format (`json`/`json5`/`yaml`/`toml`); the default is `sync-upstream.config.json`
- It needs an interactive terminal: with `--json`, with `-y`, or when there is no tty at all (which is exactly the situation in CI and behind a pipe) it refuses, with exit code 2

## 3. Or ask for the full-field template

```bash
sync-upstream --generate-config
```

This writes `./sync-upstream.config.json`, where every field carries a comment — convenient when you edit it against the documentation. For a different format or path:

```bash
sync-upstream -g -F yaml                       # -> ./sync-upstream.config.yaml
sync-upstream -g -C config/sync.json5          # -> writes to the given path, format inferred from the extension
```

`--help`, `--version` and `--generate-config` run before every other check, so you can use them before any config exists.

## 4. The three fields that are not optional

`upstreamRepo`, `syncDirs` and `companyBranch` decide "sync from where, sync what, sync into where" (a file that `init` generated already has them filled in):

```json
{
  "upstreamRepo": "https://github.com/vuejs/core.git",
  "upstreamBranch": "main",
  "companyBranch": "company/main",
  "syncDirs": ["packages/shared"],
  "commitMessage": "chore(sync): sync packages/shared from upstream"
}
```

A `syncDirs` entry can be a directory or the **path of a single file** (for example `["package.json"]`); the latter matches exactly that one file. `upstreamBranch` is not limited to branches: tags, commit ids and `refs/…` all work.

Every other field is optional and falls back to a built-in default; the layering and override rules live in the [configuration file](/en/guide/configuration) guide.

## 5. Look at the current state first

Three read-only subcommands never touch the working tree, never switch branches and never commit, and each one takes `--json`:

```bash
sync-upstream status              # branch, target branch, pending counts, config, repo lock and upstream snapshot (stays offline)
sync-upstream doctor              # a check-up: Node/git, config, credentials, branches, sync directories, state file, repo lock, working-tree changes, plus webhook / notifications / gray release / delete and rename policy / fetching / logging / PR mode
sync-upstream why packages/shared/src/index.ts   # why this file is synced / skipped
```

`doctor` exits with code 1 as soon as something blocking is found, which makes it usable as a CI pre-flight check. Without `--fetch`, `status` stays offline and reads the upstream snapshot you already have locally. All three run even in a repository that has no config file yet (`why` is the exception — it needs a usable configuration to answer anything), and every missing field is listed in the output and in the `warnings` array of `--json`.

## 6. Preview the plan first

```bash
sync-upstream -P            # preview
sync-upstream -P -V         # preview and list every changed path (only the first 40 show by default)
```

Example output (the default language is Chinese, so this is what a plain run prints):

```text
计划: 3 项变更 (源 refs/remotes/sync-upstream/main → 目标 company/main)
+ packages/shared/src/new-file.ts (packages/shared)
~ packages/shared/src/index.ts (packages/shared)
- packages/shared/src/old.ts (packages/shared)

 WARN  预览模式：不会修改工作区
```

The first line reads "Plan: 3 changes (source refs/remotes/sync-upstream/main -> target company/main)" and the warning reads "Preview mode: the working tree is not modified". Pass `--lang en` and both print in English.

Preview does **not** switch branches, modify the working tree, stage, or commit. It still adds or updates the remote named `sync-upstream` and fetches upstream content; those writes only touch the repository's git data and never your files.

## 7. Run it for real

```bash
sync-upstream               # apply the plan and commit
sync-upstream -p            # after committing, push to the target branch upstream
```

```text
应用完成: 3 个文件写入, 0 个保留本地, 0 个失败
已提交 1a2b3c4d（3 个文件）
```

Those two lines read "Apply complete: 3 files written, 0 kept local, 0 failed" and "Committed 1a2b3c4d (3 files)".

The commit carries only the paths applied by this run, so uncommitted work from other people in your working tree is never swept in. To sync only "what changed since last time", add `--incremental`. Changed your mind after a run? `sync-upstream --undo` takes it back; ran a few and want to look them over? `sync-upstream history` lists them — see [Everyday sync](/en/guide/sync-basics).

## Three common starting points

**Zero config, one command** (pass every field and add `-y` if you want no prompts):

```bash
sync-upstream -y -r https://github.com/org/upstream.git -d src/utils,docs -b main -c company/main -P
```

**In CI** (a complete config plus `-y` is what gives you zero prompts; under `-y` the `prompt-user` conflict strategy automatically degrades to keeping the local file):

```bash
sync-upstream -C sync-upstream.config.json -y --conflict-strategy keep-target --push
```

**Gray release first** (ship 20%, verify it, then release everything):

```bash
sync-upstream -gr --percentage 20
sync-upstream -gr --full-release
```

## Authenticating to private repositories

Three ways. `--auth-type` must be given explicitly (without it, none of the other auth fields have any effect):

```bash
# SSH: point at a private key
sync-upstream -r git@github.com:org/private.git -d src/utils --auth-type ssh --auth-key ~/.ssh/id_ed25519

# token
sync-upstream -r https://github.com/org/private.git -d src/utils --auth-type pat --auth-token <token>

# username + password
sync-upstream -r https://gitlab.example.com/org/private.git -d src/utils \
  --auth-type user_pass --auth-username <username> --auth-password <password>
```

You can also write the same fields into the config file's `authConfig`.

Points worth knowing:

- **Credentials stay inside your repository**: the `pat` / `user_pass` credential is written into the `sync-upstream` remote URL in `.git/config`. Addresses in logs and error messages are always masked, but never paste `.git/config` into an issue or a log archive. With SSH the URL contains no key.
- **A passphrase-protected private key needs ssh-agent**: the tool never asks for a passphrase interactively; it fails outright on a key that has one.
- **The tool never goes looking for credential environment variables**: `--auth-token "$GIT_TOKEN"` works only because your shell expanded it first. The only variables it reads are `SYNC_UPSTREAM_LANG`, `LC_ALL`, `LANG`, `LANGUAGE` (output language) and `GITHUB_STEP_SUMMARY` (the CI summary). In CI inject your secret your own way; the same applies to the config file.
- Your git proxy, `insteadOf` and credential helper settings keep working as usual, because the tool calls the `git` on your machine.

## Next steps

- By task: [everyday sync](/en/guide/sync-basics) · [conflict handling](/en/guide/conflicts) · [gray release and rollback](/en/guide/gray-release) · [webhook daemon](/en/guide/webhook) · [CI and automation](/en/guide/automation)
- Flag by flag: [CLI reference](/en/reference/cli) · [configuration reference](/en/reference/configuration) · [API reference](/en/reference/api)
