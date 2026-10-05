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

## Verify

```bash
sync-upstream --version   # prints the version number
sync-upstream --help      # prints the full flag list
```

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
