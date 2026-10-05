# Changelog

Notable changes are recorded here. The machine-generated part of released versions lives in the repository-root [CHANGELOG.md](https://github.com/flow-zy/sync-upstream/blob/master/CHANGELOG.md); this page adds the behaviour-level notes.

## [Unreleased] Full rewrite

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
- Exit codes are fixed at 0 success (including an interactive cancel) / 1 unexpected error or at least one failed file / 2 configuration, validation or unrecognised flag / 3 git operation failure; 4 is reserved and never produced today

### Added

- `.sync-state.json` backs incremental runs: content already synced is skipped automatically, and the record is invalidated and rebuilt when the upstream repository or branch changes
- Gray release: `.sync-gray.json` records progress and `.sync-gray-audit.jsonl` records stage transitions; `--full-release` / `--rollback` work from those records, and a successful full release cleans up the progress file automatically
- Conflict detection (the four kinds that occur: content, delete-modify, untracked-overwrite, type) plus three-way merge, with explicit fallbacks for binary and very large files, so a change is never lost because it "could not be merged"
- Webhook daemon mode: multi-platform signature verification, IP/CIDR allow-listing, per-IP rate limiting, a 1 MiB request body cap, event filter rules, and acknowledge-then-sync asynchronously
- gitignore-semantics ignore rules (`.gitignore`, `.syncignore`, configuration entries, and nested rules inside sync directories, which take precedence)
- `syncDirs` accepts a single file path, so "sync just one file" needs no special mode

### Documentation

The documentation site is a **pure usage guide**: it covers installation, operations, configuration and troubleshooting only. Neither the Chinese pages nor this English mirror under `docs/en/` contains architecture or implementation documentation — there is no page describing internal design, source layout, or data flow.

- The architecture pages (architecture overview, state files and contracts) and their entries in the site were removed; the user-facing part, "runtime files and cleanup", was merged into [the configuration reference](/en/reference/configuration#runtime-files-and-cleanup)
- Source paths, internal symbols, data-flow and design-decision wording were dropped site-wide in favour of "what happens / how to do it / what to do when it fails"
- Added the comparison page [vs. built-in fork sync](/en/guide/vs-fork-sync): scenario-by-scenario against the "Fetch upstream" built into GitHub / Gitee, including the cases where this tool is the wrong choice
- Added the complete English documentation under `docs/en/` (page-for-page with the Chinese docs, switchable from inside the site) and [README.en.md](https://github.com/flow-zy/sync-upstream/blob/master/README.en.md)
- Wording corrections: the number of conflict types, the rule that `-y` asks nothing only when the configuration is complete, `-V` not implying debug logs, previews still fetching upstream, exit code 4 being reserved, `.sync-state.json` being the only file on the built-in ignore list, and `pat` / `user_pass` credentials being written into the remote URL in `.git/config`

### Reliability

- The whole "apply -> commit -> result" flow of a sync is verified end to end, covering flag mapping, configuration loading and aliases, conflict resolution, gray release selection, webhook verification and rate limiting, and the incremental baseline

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
