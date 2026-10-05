---
# sync-upstream
layout: home

hero:
  name: "sync-upstream"
  text: "Directory-level upstream code sync"
  tagline: Sync only the directories you name, see the plan before anything changes, with gray release, rollback, and an auditable commit
  image:
    src: /sync-upstream-hero.svg
    alt: sync-upstream
  actions:
    - theme: brand
      text: Quick start
      link: /en/guide/quick-start
    - theme: alt
      text: CLI reference
      link: /en/reference/cli
    - theme: alt
      text: FAQ
      link: /en/faq

features:
  - icon: 🎯
    title: Only the directories you name
    details: Nothing outside syncDirs is read, modified, or committed, so your customisations in every other directory stay untouched
  - icon: 🔍
    title: The preview is the commit
    details: It lists every path that will be added, modified, or deleted first; run only after you agree — the two are strictly identical
  - icon: ⚡
    title: Incremental + parallel
    details: Content synced before is skipped automatically, many files are applied in concurrent batches, and one bad file does not block the batch
  - icon: 🧩
    title: Conflicts have policies
    details: Files changed on both sides are detected automatically and handled as take-upstream / keep-local / three-way merge / skip
  - icon: 🚦
    title: Gray release and rollback
    details: Release a small part first and run validation, then complete it; if anything breaks, one command restores the pre-release content
  - icon: 🔐
    title: Honest errors
    details: An unreadable config aborts the run, an unknown flag is rejected, validation reports everything at once, and credentials in logs are always redacted
---

## What this tool does

When you maintain an open-source fork, `git merge upstream/main` pours **all** of upstream's changes into your tree, while in practice you usually want to follow only a few directories. sync-upstream confines the sync to the directories you list, and every step can be previewed, audited, and reverted.

It does not try to replace `git merge`: **if you need to keep upstream's commit history, use `git merge`; if you want upstream's content but not its history, use this tool.** The scenario-by-scenario comparison is in [Compared to fork syncing](/en/guide/vs-fork-sync).

## What happens in one run

1. Fetch the upstream branch and confirm the target branch is usable
2. Compute the list of paths this run changes (added / modified / deleted), applying ignore rules and the extension allow list
3. Mark the conflicted files — the ones both you and upstream changed
4. In preview mode it stops here and only prints the list; a real run applies the changes and commits them
5. When you want a steadier release cadence, the same list can be released in part first, then completed in full or rolled back

## Up and running in three minutes

```bash
npm install -g sync-upstream

cd /path/to/your-repo
sync-upstream --generate-config          # writes sync-upstream.config.json
# edit upstreamRepo / upstreamBranch / companyBranch / syncDirs
sync-upstream --preview-only --verbose   # look at the full plan first
sync-upstream                            # then run it for real
```

You can also do it in one command with no configuration file:

```bash
sync-upstream -r https://github.com/vuejs/core.git \
  -d packages/runtime-core,packages/shared \
  -b main -c company/main -P
```

## Read it by situation

- Deciding whether it fits: [Compared to fork syncing](/en/guide/vs-fork-sync)
- Getting it running the first time: [Quick start](/en/guide/quick-start) → [Usage overview](/en/guide/usage) → [Daily sync](/en/guide/sync-basics)
- Stuck: [FAQ](/en/faq) · [Exit codes and logging](/en/guide/automation#exit-codes)
- Deep dives: [Conflict handling](/en/guide/conflicts) · [Gray release and rollback](/en/guide/gray-release) · [Webhook daemon](/en/guide/webhook) · [CI and automation](/en/guide/automation)
- Look things up: [CLI reference](/en/reference/cli) · [Configuration reference](/en/reference/configuration) · [API reference](/en/reference/api)
- The project: [Installation guide](/en/guide/installation) · [Configuration guide](/en/guide/configuration) · [Feature record](/en/features) · [Changelog](/en/changelog)

## Prerequisites

- The current directory is already a Git repository (`git init` is enough) and the target branch exists
- You have read access to the upstream repository and write access to the target branch (only needed with `--push`)
- Node.js ≥ 18.2, Git ≥ 2.25
