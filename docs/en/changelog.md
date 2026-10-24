# Changelog

Notable changes are recorded here. The machine-generated part of released versions lives in the repository-root [CHANGELOG.md](https://github.com/flow-zy/sync-upstream/blob/master/CHANGELOG.md); this page adds the behaviour-level notes.

## [0.3.0-beta.0](https://github.com/junjie73-blip/sync-upstream/compare/v0.2.8-0...v0.3.0-beta.0) (2026-10-23)

A pre-release, installed under the npm `next` tag (`npm i -g sync-upstream@next`); `latest` is still `0.2.8-0`. Below is everything relative to 0.2.8-0: a rewrite of the overwrite decision, concurrency and commit boundaries, plus this round's feature batch.

### Breaking changes

- **The cache layer and the LFS-specific configuration are gone**: `useCache` / `cacheDir` / `cacheConfig` / `useLFS` / `largeFileThreshold` / `lfsTrackPatterns` / `adaptiveConcurrency` no longer exist, and writing them only yields a deprecation warning
- **The visual dashboard is gone**
- **No JavaScript configuration format**: JSON / JSON5 / YAML / TOML are supported, while JS configs such as `sync.config.js` and `.sync-upstream.config.js` are no longer read (legacy key names are still accepted through aliases)
- **Command-line flags consolidated**: `--rm` / `--rd` / `--rb` / `--cl` / `--branch-strategy` / `--base-branch` / `--branch-pattern` and aliases such as `-wp` / `-wpa` / `-ws` / `-wev` / `-wb` were removed; added `--ignore`, `--include-types`, `--conflict-strategy`, `--incremental`, `--strategy` / `--percentage` / `--canary-dirs` / `--file-patterns` / `--validation-script`, `--auth-*`, `-g/--generate-config`. Unrecognised flags are now rejected outright (exit code 2)
- **Enum values are lower-case hyphenated**: conflict strategies `use-source` / `keep-target` / `auto-merge` / `prompt-user` / `skip`; gray release strategies `percentage` / `directory` / `file`; branch strategies `feature` / `release` / `hotfix` / `develop`
- **Authentication keeps only `ssh` / `pat` / `user_pass`** (GitHub App and OIDC, promised by earlier documentation, were never implemented)
- **Clear semantics for `--force` and `--incremental`**: the first applies the entire change list by force, the second restores incremental judgement; `forceOverwrite: true` is the default

### Behaviour changes

- A specified configuration file that cannot be read, lacks permission, is syntactically broken, or has a non-object top level ends the run with the reason (including parse failures per format) instead of silently falling back to the defaults
- Configuration validation lists every problem at once; both alias keys and unrecognised keys produce warnings
- Previews (`-P` / `-n`) no longer switch branches or move HEAD; they only check that the target branch exists. They still add or correct the `sync-upstream` remote and fetch upstream, so a preview fails just the same when you are completely offline
- `-V` no longer swallows ordinary info-level logs, and it prints the full change list rather than the first 40 entries
- A commit carries only the paths applied in this run; unrelated dirty files in the working tree are never reported as changes and never trigger `nothing added to commit`
- When upstream relocates unchanged content, the scopes end up with zero difference against upstream after the sync, so no files are left behind "added but never deleted"
- An empty gray release selection now fails with an error, fixing the "stuck spinning at 0%" state
- Upstream is fetched through the separate remote `sync-upstream`; `origin` is no longer rewritten, and no temporary branches or temporary directories are created
- Credential-bearing URLs in logs and error messages are always redacted
- The default of `branchStrategyConfig.branchPattern` is now `feature/sync-{date}`: in the previous default `feature/{name}`, `{name}` was not a supported placeholder, so enabling `enable` without giving a pattern created a branch whose name literally contained `{name}`
- Exit codes are fixed at 0 success (including "no changes", a preview run, and cancelling a sync with `Ctrl+C`) / 1 unexpected error or at least one failed file / 2 configuration, validation or unrecognised flag / 3 git operation failure / 4 cancelling the `init` questionnaire / 5 the repository lock could not be taken
- Upstream renames are collapsed into a single move by default (instead of "delete half, add half"); `--no-renames` restores the old behaviour, and the similarity threshold is `--rename-threshold` (default 60)
- With several upstreams (fan-in) each one writes its own `.sync-state-<name>-<hash>.json`; a single upstream still writes `.sync-state.json`, backwards compatible with the 0.2 format, and old files migrate automatically
- Two upstreams can no longer fight over the same repository lock inside one run: when `.git/sync-upstream.lock` is held the run fails immediately by default, and `--lock-wait <ms>` is what makes it queue instead
- `status`, `doctor`, `history` and `--undo` now produce a report even with no config file, or with one that is missing fields: every missing item is listed in `warnings`, and `doctor` counts it as a blocker (exit code 1). `why` still needs a usable configuration and exits 2 with the validation failure without one

### Added

- **Read-only subcommands**: `status` (what the state is now, only `--fetch` goes online), `why <path>` (why this file did not sync), `doctor` (what is wrong with the environment or the configuration), `history` (which syncs ran recently, 10 entries by default, `--limit` to change it); all four accept `--json` and emit one `jq`-parsable document, which pairs with `$GITHUB_STEP_SUMMARY` in CI
- **Undo**: `-uo, --undo` restores the last sync from the baseline commit recorded in the state file; it works offline and never rewrites already-pushed history
- **Notification hooks**: `notifyConfig` / `--notify` report the outcome to stdout, HTTP, Slack, DingTalk and WeCom once the run finishes (`--notify-url` / `--notify-events`); a failed delivery is only logged and never changes the sync result
- **Multiple upstreams and any ref**: `upstreams` or repeated `-r` / `-b` merges several upstreams into one target branch; `upstreamBranch` may be a branch, a tag or a commit, and the `refs/heads/…` / `refs/tags/…` prefixes disambiguate them
- **Deletion protection**: `deletePolicy` has three values — `mirror` (default, matching historic behaviour: what upstream deleted gets deleted), `keep` (keep it and report the skip), `ask` (ask once per run when a terminal is available)
- **GitOps PR mode**: `--pr` commits the changes onto an auto-generated branch and pushes it while leaving the target branch alone; `--pr-branch` / `--pr-remote` / `--pr-title` / `--pr-body` / `--pr-draft` / `--pr-no-create` control the details
- **Fetching large repositories**: `--fetch-filter none|blob|tree` for a partial clone, `--fetch-depth` for a shallow one, `--fetch-tags` decides whether tags are fetched; `--lfs pointer|materialize|off` decides whether an LFS file arrives locally as pointer text or as real content
- **The webhook daemon is production-shaped**: signature/token verification, IP and CIDR allow-listing, per-IP rate limiting, a 1 MiB request body cap, event and branch filters, a `--webhook-queue` cap (default 8), and `--webhook-log` for a per-delivery audit trail (JSONL)
- **Logging on disk**: `--log-file` writes logs to a file as well, rotated at `--log-max` (default 5 MiB) with `--log-keep` files retained (default 5); `--log-json` / `--no-log-json` switch to one JSON object per line
- **Bilingual output**: `--lang zh|en` chooses the language for help, errors and run logs, and it also reads `SYNC_UPSTREAM_LANG` / `LC_ALL` / `LANG` / `LANGUAGE`; Chinese is the default, every string maps one-to-one to code, and a test asserts the two key sets match
- **Shell completion**: `completion bash|zsh|fish` prints a completion script you can `source` directly, covering subcommands and every flag
- **Guided initialisation**: `init` asks question by question and writes the configuration file (refusing to run with `-y` or without a terminal), with a clear division of labour against the older `--generate-config`
- One lock per repository: two syncs in the same working directory cannot trample each other, and a stale lock is taken over automatically
- `.sync-state.json` backs incremental runs: content already synced is skipped automatically, and the record is invalidated and rebuilt when the upstream repository or branch changes
- Gray release: `.sync-gray.json` records progress and `.sync-gray-audit.jsonl` records stage transitions; `--full-release` / `--rollback` work from those records, and a successful full release cleans up the progress file automatically
- Conflict detection (the four kinds that occur: content, delete-modify, untracked-overwrite, type) plus three-way merge, with explicit fallbacks for binary and very large files, so a change is never lost because it "could not be merged"
- Webhook daemon mode: multi-platform signature verification, IP/CIDR allow-listing, per-IP rate limiting, a 1 MiB request body cap, event filter rules, and acknowledge-then-sync asynchronously
- gitignore-semantics ignore rules (`.gitignore`, `.syncignore`, configuration entries, and nested rules inside sync directories, which take precedence)
- `syncDirs` accepts a single file path, so "sync just one file" needs no special mode

### Documentation

The documentation site is a **pure usage guide**: it covers installation, operations, configuration and troubleshooting only, and no longer contains architecture or implementation notes.

- The architecture pages (architecture overview, state files and contracts) and their entries in the site were removed; the user-facing part, "runtime files and cleanup", was merged into [the configuration reference](/en/reference/configuration#runtime-files-and-cleanup)
- Source paths, internal symbols, data-flow and design-decision wording were dropped site-wide in favour of "what happens / how to do it / what to do when it fails"
- Added the comparison page [vs. built-in fork sync](/en/guide/vs-fork-sync): scenario-by-scenario against the "Fetch upstream" built into GitHub / Gitee, including the cases where this tool is the wrong choice
- Added the complete English documentation under `docs/en/` (page-for-page with the Chinese docs, switchable from inside the site) and [README.en.md](https://github.com/flow-zy/sync-upstream/blob/master/README.en.md)
- Wording corrections: the number of conflict types, the rule that `-y` asks nothing only when the configuration is complete, `-V` not implying debug logs, previews still fetching upstream, exit code `4` now only being produced when you cancel inside `init` plus a new `5` for a held repository lock, `.sync-state.json` being the only file on the built-in ignore list, and `pat` / `user_pass` credentials being written into the remote URL in `.git/config`
- The command-line reference was rewritten against the code: the full table of 51 string flags and 32 switch rows, the `--no-x` negated forms, the behaviour boundaries of each flag group, and the exit codes; the two languages match row for row
- The feature record now covers every capability added in this round (read-only subcommands, undo, notifications, multiple upstreams, rename and deletion policies, fetching and LFS, PR mode, the webhook, logging on disk, bilingual output, completion, `init`), and the "not supported" list was rewritten to keep only the items that genuinely mislead
- The usage overview gained "the four subcommands that change nothing" and a 13-row list of common actions; the configuration reference gained every new key plus the runtime-artefact list; the 30-second start in the README now runs `init` → `doctor` → `-P` → the sync → `history`

### Reliability

- The whole "apply -> commit -> result" flow of a sync is verified end to end, covering flag mapping, configuration loading and aliases, conflict resolution, gray release selection, webhook verification and rate limiting, and the incremental baseline
- The suite grew to 56 files: repository lock, multi-upstream fan-in, rename and deletion policies, undo and history, notification delivery, fetching and LFS policy, completion scripts, and the zh/en key-parity check each have their own file; anything that writes to disk or commits runs against throwaway fixture repositories, while real repositories are only ever read
- CI gained a `typecheck` + `lint` gate and an ubuntu / windows / macos × Node 20 / 22 test matrix, with coverage floors and a smoke run of the artefacts on all three platforms (`--version` / `--help` / `--lang en --help` / `completion`)
- The npm publish job runs the checks and tests first and verifies that the tag name matches the `package.json` version; a pre-release version containing `-` publishes to the `next` tag and never takes over `latest`
- Coverage reports no longer go into version control

## [0.2.7](https://github.com/flow-zy/sync-upstream/compare/v0.2.6...v0.2.7) (2025-08-18)

- Improved the cache system and the sync flow (this cache layer was removed in the later rewrite)
- Extended the conflict types and resolution strategies

## [0.2.6](https://github.com/flow-zy/sync-upstream/compare/v0.2.5...v0.2.6) (2025-08-17)

- Webhook enhancements and security configuration
- Cache compression, warm-up and per-content-type expiry policies (all removed today)

## [0.2.5](https://github.com/flow-zy/sync-upstream/compare/v0.2.4...v0.2.5) (2025-08-16)

- Introduced the advanced cache system and performance optimisations (all removed today)

## [0.2.0](https://github.com/flow-zy/sync-upstream/compare/v0.1.0...v0.2.0) (2025-08-13)

### Bug Fixes

- Fixed flag handling in non-interactive mode

### Features

- Added large-file handling and local caching (removed today)
- Added large-file and cache options to `SyncOptions`

## [0.1.0](https://github.com/flow-zy/sync-upstream/compare/v0.0.2...v0.1.0) (2025-08-13)

### Features

- Added parallel processing, authentication support and preview mode
- Added non-interactive mode support and migrated the build to tsup
- Added the complete documentation structure and content
