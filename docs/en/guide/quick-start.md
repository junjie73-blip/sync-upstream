# Quick start

Goal: five commands covering "install -> configure -> preview -> sync -> push". Nothing outside the directories you name gets touched.

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

## 2. Generate a config file

```bash
cd /path/to/your-repo
sync-upstream --generate-config
```

This writes `./sync-upstream.config.json`. Its content is the full set of default values, including every key that carries meaning. For a different format or path:

```bash
sync-upstream -g -F yaml                       # -> ./sync-upstream.config.yaml
sync-upstream -g -C config/sync.json5          # -> writes to the given path, format inferred from the extension
```

`--help`, `--version` and `--generate-config` run before every other check, so you can use them before any config exists.

## 3. Fill in the required fields

`upstreamRepo`, `syncDirs` and `companyBranch` decide "sync from where, sync what, sync into where":

```json
{
  "upstreamRepo": "https://github.com/vuejs/core.git",
  "upstreamBranch": "main",
  "companyBranch": "company/main",
  "syncDirs": ["packages/shared"],
  "commitMessage": "chore(sync): sync packages/shared from upstream"
}
```

A `syncDirs` entry can be a directory or the **path of a single file** (for example `["package.json"]`); the latter matches exactly that one file.

Every other field is optional and falls back to a built-in default; the layering and override rules live in the [configuration file](/en/guide/configuration) guide.

## 4. Preview the plan first

```bash
sync-upstream -P            # preview
sync-upstream -P -V         # preview and list every changed path (only the first 40 show by default)
```

Example output:

```text
Plan: 3 changes (source refs/remotes/sync-upstream/main -> target company/main)
+ packages/shared/src/new-file.ts (packages/shared)
~ packages/shared/src/index.ts (packages/shared)
- packages/shared/src/old.ts (packages/shared)

 WARN  Preview mode: the working tree is not modified
```

Preview does **not** switch branches, modify the working tree, stage, or commit. It still adds or updates the remote named `sync-upstream` and fetches upstream content; those writes only touch the repository's git data and never your files.

## 5. Run it for real

```bash
sync-upstream               # apply the plan and commit
sync-upstream -p            # after committing, push to the target branch upstream
```

```text
Apply complete: 3 files written, 0 kept local, 0 failed
Committed 1a2b3c4d (3 files)
```

The commit carries only the paths applied by this run, so uncommitted work from other people in your working tree is never swept in. To sync only "what changed since last time", add `--incremental`.

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
- **The tool reads no environment variables**: `--auth-token "$GIT_TOKEN"` works only because your shell expanded it first. In CI inject your secret your own way; the same applies to the config file.
- Your git proxy, `insteadOf` and credential helper settings keep working as usual, because the tool calls the `git` on your machine.

## Next steps

- By task: [everyday sync](/en/guide/sync-basics) · [conflict handling](/en/guide/conflicts) · [gray release and rollback](/en/guide/gray-release) · [webhook daemon](/en/guide/webhook) · [CI and automation](/en/guide/automation)
- Flag by flag: [CLI reference](/en/reference/cli) · [configuration reference](/en/reference/configuration) · [API reference](/en/reference/api)
