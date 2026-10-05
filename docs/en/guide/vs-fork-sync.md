# Compared with GitHub / Gitee built-in fork sync

This page answers a very common question: **upstream already lives on GitHub / Gitee, and "Fetch upstream" is a single button — why would you need a command-line tool at all?**

Conclusion first, then examples.

> Conclusion: **if all you want is to bump your fork's default branch to upstream's latest every now and then, the built-in feature is less work** — one click, zero configuration, nothing to install. This tool does not try to replace that step.
>
> What it does solve is the kind of requirement the built-in feature cannot meet: **taking only a few directories from upstream while keeping your own customisations in every other directory.**

The commands below all assume `upstreamRepo` / `companyBranch` are already written in the config file and use `-d` to override the sync scope; for the from-scratch form see [Quick start](/en/guide/quick-start).

---

## Example 1: track only part of upstream

The company repository `acme/core` is a fork of `vuejs/core`, and we only want to follow `packages/runtime-core` — `apps/`, `examples/` and `packages/compiler-*` are all places we have changed ourselves.

What the built-in fork sync does: merge **all** of upstream `main`'s changes in. This time upstream touched 800 files, 6 of which land in our customised directories — so we would have to resolve conflicts in those 6 files, and those 6 files are exactly the ones we did not want to touch at all.

What this tool does:

```bash
sync-upstream -r https://github.com/vuejs/core.git -b main \
  -d packages/runtime-core -c company/main --preview-only
```

Files outside the scope are not read, not modified, and not committed. Every path that shows up in the plan is a path that shows up in the final commit.

`syncDirs` allows a single file:

```json
{ "syncDirs": ["packages/runtime-core", "packages/shared/patchFlags.ts"] }
```

---

## Example 2: see the change list before accepting it

The built-in feature has no "preview". Either it merges or it does not.

This tool prints the plan first:

```text
计划: 4 项变更 (源 refs/remotes/sync-upstream/main → 目标 company/main)
~ packages/runtime-core/src/renderer.ts (packages/runtime-core)
~ packages/runtime-core/src/component.ts (packages/runtime-core)
+ packages/runtime-core/src/rendererTemplateRef.ts (packages/runtime-core)
- packages/runtime-core/src/oldScheduler.ts (packages/runtime-core)
冲突: 1 个文件本地与上游都有改动
  ! packages/runtime-core/src/component.ts [content]
```

(`~`/`+`/`-` mean modify / add / delete, the parenthesised name is the sync scope that matched; past 40 entries only the first 40 are listed by default, `-V` prints the complete list.)

The two label lines above are the tool's actual Chinese output: `计划: 4 项变更 (源 … → 目标 …)` reads "Plan: 4 changes (source … → target …)", and `冲突: 1 个文件本地与上游都有改动` reads "Conflicts: 1 file changed on both the local side and upstream".

A preview switches no branch, touches no HEAD, and creates no commit (it still makes sure the remote exists and fetches once, which is a read-only operation). Once the plan looks right, run again without `--preview-only`.

---

## Example 3: conflicts have policies

Upstream changed `src/component.ts` and we changed the very same spot. The built-in feature hands that file to git's default merge: conflict markers land in the working tree, and a human has to sort them out.

This tool handles them per policy:

```bash
# this directory always follows upstream
sync-upstream -d packages/runtime-core --conflict-strategy use-source

# on CI never prompt, always keep local on conflict
sync-upstream -d packages/runtime-core -y --conflict-strategy keep-target
```

`auto-merge` performs a real three-way merge (against the common ancestor of the two sides) and only writes conflict markers when it cannot merge; binary files and the case where both sides deleted are marked separately as `skip` and do not affect the other files in the same batch.

---

## Example 4: ship a large upstream change in batches

Upstream refactored 200 files in one go. The built-in feature is all-or-nothing.

With this tool you can release 20% first, run the validation script, and fill in the rest once it passes:

```bash
sync-upstream -gr --percentage 20 --validation-script "pnpm test"   # canary
sync-upstream -fr                                                   # fill in the rest after validation passes
sync-upstream -ro                                                   # or roll back only the batch already released
```

Rolling back adds one new rollback commit (content returns to the gray release baseline) instead of running `git reset`, so already-pushed history is never rewritten.

---

## Example 5: the target branch is not the default one

Built-in sync mostly works against the default branch only; on Gitee it is outright unavailable when the fork branch carries local commits of its own.

We have three internal branches that all follow upstream — `company/main`, `company/release-5.2`, `company/hotfix-2026-03`. This tool takes any target branch via `-c`, and with a CI matrix it is one command run once per branch.

---

## Example 6: scheduled and event-driven sync

A click-to-sync button cannot do "follow upstream every night at 3 a.m. and alert on failure".

```yaml
# .github/workflows/sync.yml
- run: npx sync-upstream -C sync-upstream.config.json -y
```

It can also stay resident and listen for upstream pushes:

```bash
sync-upstream -we --webhook-secret "$WH_SECRET" --webhook-branch main
```

(`$WH_SECRET` is expanded by the shell before it reaches the tool — the tool itself reads no environment variables at all.)

---

## When not to use it

| Need | Use instead |
|---|---|
| One click to bring the fork's default branch up to upstream's latest | The built-in "Fetch upstream" / Sync fork |
| Keep upstream's commit history and merge relationships | `git merge upstream/main` |
| Linear history, rebasing upstream commits | `git rebase` |
| Turn the upstream changes into a PR to review yourself | `git merge --no-commit`, then tidy up by hand |
| Track only specific directories while protecting customisations elsewhere | This tool |
| Track only specific directories with preview / batching / rollback / scheduling | This tool |

One principled difference is worth remembering: **this tool syncs content, not history.** What it produces is an ordinary commit that aligns the files inside the sync scope to the state they had at that upstream commit; upstream's commit graph is not moved into your repository. To preserve the historical thread, `git merge` is the right tool.

---

## Related pages

- [Usage overview](/en/guide/usage) — the full flow of one run
- [Everyday sync](/en/guide/sync-basics) — sync scopes and preview
- [Conflict handling](/en/guide/conflicts) — 4 conflict kinds and 5 strategies
- [Gray release and rollback](/en/guide/gray-release) — releasing in batches
- [CI and automation](/en/guide/automation) — scheduled and unattended runs
- [CLI reference](/en/reference/cli) — every flag
- [FAQ](/en/faq)
