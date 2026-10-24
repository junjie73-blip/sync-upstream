/**
 * What a run does when the upstream no longer has a file the target branch still has.
 *
 * `mirror` is what the tool has always done and what a directory sync usually means: the synced
 * directories become byte-for-byte upstream's. `keep` turns every such deletion into a skip,
 * which is the option a team needs when the same directory carries locally added files.
 * `ask` is the interactive form of the same question and degrades to `keep` when nothing can
 * answer (`-y`, `--json`, a CI job).
 */
export type DeletePolicy = 'mirror' | 'keep' | 'ask'

export const DELETE_POLICIES: DeletePolicy[] = ['mirror', 'keep', 'ask']

/**
 * 60 is git's own default (`--find-renames=60%`), and it is the number that keeps a renamed
 * file from being reported as "deleted here, added there" while still refusing to pair two
 * files that merely look alike.
 */
export const DEFAULT_RENAME_THRESHOLD = 60

/**
 * GitOps flavour of a run: nothing lands on the target branch. The commits go to a generated
 * branch, that branch is pushed, and the reviewer gets a compare link or a real pull request.
 */
export interface PrConfig {
  enable: boolean
  /**
   * Branch to work on. `{target}` is the configured target branch, `{date}` a `yyyymmdd` stamp.
   * Defaults to `sync-upstream/{target}-{date}`.
   */
  branchPattern?: string
  /** Remote the branch gets pushed to. Defaults to the target branch's upstream, else `origin`. */
  remote?: string
  title?: string
  /** Extra text under the generated body in the PR description. */
  body?: string
  draft?: boolean
  /**
   * `auto` (default) opens the PR with `gh`/`glab` when that CLI is installed; `never` only
   * prints the compare link. A PR is never a reason for a sync run to fail.
   */
  create?: 'auto' | 'never'
  /** Which CLI to call when `create` is not `never`; picked from the remote host by default. */
  tool?: 'gh' | 'glab'
}
