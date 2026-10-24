# Installation

## Requirements

| Dependency | Minimum version | Reason |
|---|---|---|
| Node.js | 18.2 | runtime requirement; below it the webhook daemon cannot close connections properly |
| Git | 2.25 | older versions cannot guarantee that a commit carries only the paths synced this run |
| pnpm / npm | any modern version | installing and running scripts |

The tool calls the `git` subcommands on your machine directly and does not use libgit2, so your everyday git configuration (proxy, `insteadOf`, credential helper) keeps working as usual.

## Install

```bash
# global install, gives you the `sync-upstream` command
npm install -g sync-upstream
# or
pnpm add -g sync-upstream

# project install, version pinned through package.json
pnpm add -D sync-upstream
npx sync-upstream --version
```

The package is published to npm as `sync-upstream`, and its current `latest` is `0.2.8-0`: plain `npm install -g sync-upstream` does **not** give you this site's 0.3.0 features. The 0.3.0 prereleases land on the `next` dist-tag, so install the documented version explicitly with `npm install -g sync-upstream@next` (or `pnpm add -g sync-upstream@next`, `pnpm add -D sync-upstream@next`). Once that is done, run `sync-upstream init` to write your first configuration file and `sync-upstream doctor` to check that the repository, git, and remote setup can actually sync — see [Quick start](/en/guide/quick-start).

## Verify

```bash
sync-upstream --version   # prints the version number
sync-upstream --help      # prints the full flag list
```

## Shell completion

`completion` prints a completion script generated from the flag table to stdout, so redirect it into your completion directory:

```bash
# bash
sync-upstream completion bash > /usr/share/bash-completion/completions/sync-upstream
# zsh (a directory on fpath, and the file must be named _sync-upstream)
sync-upstream completion zsh > "${fpath[1]}/_sync-upstream"
# fish
sync-upstream completion fish > ~/.config/fish/completions/sync-upstream.fish
```

- The script is generated from the flag table as it stands now, so re-run it once after an upgrade to complete the new flags; after `completion` it keeps completing the three shell names `bash`/`zsh`/`fish`
- It completes flags and subcommands only, it will not guess your repository URL; a wrong shell name exits with code `2` and prints the correct usage
- Once written, load it the way your shell expects (reopen the terminal, or `source` the file)

## Output language

Help text, argument errors, and error messages all follow the active language, either `zh` or `en`:

```bash
sync-upstream --lang en --help     # English for this run
export SYNC_UPSTREAM_LANG=en       # applies to this tool only, the highest-priority variable
```

The resolution order is `--lang` → `SYNC_UPSTREAM_LANG` → `LC_ALL` → `LANG` → `LANGUAGE`: a locale starting with `zh` means Chinese, any other recognised locale means English, and when there is no signal at all (or only `C`/`POSIX`) it stays Chinese — that is how the tool has always answered. `--lang` switches the output language only: it is never written into the configuration layer and has no configuration key, and a value outside `zh`/`en` is explained **in the language you already had**.

The interactive questions and the configuration summary are currently Chinese only.

## Running from the source repository

```bash
git clone https://github.com/flow-zy/sync-upstream.git
cd sync-upstream
pnpm install
pnpm build            # output lands in dist/, and bin/sync-upstream prefers it
pnpm test             # unit tests + end-to-end tests against real git fixtures
pnpm docs:dev         # local preview of the documentation site
```

When `bin/sync-upstream` cannot find `dist/cli.js`, it tells you to run the build first instead of failing silently.

## Next steps

- [Quick start](/en/guide/quick-start): run your first preview after installing
- [Configuration file](/en/guide/configuration): write your first config
- [Usage overview](/en/guide/usage): the entry point to all focused pages
- [CLI reference](/en/reference/cli): the default value and target of every flag listed in `--help`
