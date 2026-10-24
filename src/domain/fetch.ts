import type { RepoPath } from './change'

/**
 * How much of the upstream gets pulled into the local repository.
 *
 * A directory sync of a monorepo used to mean "fetch every object of the source branch", which
 * on a large upstream is minutes and gigabytes for a handful of folders. These options trade that
 * away, and each one has a cost the operator should know about — hence the doc comments rather
 * than a magic default.
 */

/**
 * Object filtering (git's `--filter`), asked of the server at fetch time.
 *
 * - `none`: everything, which is what every release up to 0.2 did and the only mode that can
 *   show an upstream file's contents offline.
 * - `blob`: blobless — commits and trees arrive, file contents are fetched on demand. Cheapest
 *   option that still lets a plan be built and a diff be compared without surprises.
 * - `tree`: treeless — only commits arrive until a path is actually needed. Smallest transfer,
 *   but every `git show`/`ls-tree` may round-trip, so a sync of a wide directory can end up
 *   making more requests than it saved.
 */
export type PartialFilter = 'none' | 'blob' | 'tree'

export const PARTIAL_FILTERS: PartialFilter[] = ['none', 'blob', 'tree']

/**
 * What to do with files the upstream keeps in Git LFS.
 *
 * A sync copies *blob contents* (`git checkout <ref> -- <path>`), and an LFS-tracked blob is
 * just a pointer text file in git. So the tool has to pick what lands in the working tree:
 *
 * - `pointer` (default): write the pointer, never touch the network, never fail because an LFS
 *   endpoint is unreachable. Correct for source code, useless for a binary asset.
 * - `materialize`: after the pointer is written, ask the upstream remote for the real object and
 *   replace it — needs `git-lfs` locally and an LFS server that serves the upstream.
 * - `off`: don't look at all; the pointer is written silently.
 */
export type LfsMode = 'pointer' | 'materialize' | 'off'

export const LFS_MODES: LfsMode[] = ['pointer', 'materialize', 'off']

export interface FetchConfig {
  filter: PartialFilter
  /**
   * `--depth` for the source fetch: only the newest N commits arrive.
   *
   * Shallow makes the *local repository* shallow (`.git/shallow`), which shortens everybody else's
   * `git log` too, and it breaks rename detection and any source older than the window. Opt-in
   * for that reason: `depth` is only honoured when it is written down.
   */
  depth?: number
  /**
   * Fetch the tags the sync dirs' history points at (`--no-tags` is the default and keeps an
   * ordinary branch fetch from dragging the upstream's whole tag list in).
   */
  tags: boolean
  lfs: LfsMode
}

export const DEFAULT_FETCH_CONFIG: FetchConfig = {
  filter: 'none',
  tags: false,
  lfs: 'pointer',
}

/** The `--filter` value git expects, or null when nothing should be filtered. */
export function filterArg(filter: PartialFilter): string | null {
  if (filter === 'blob')
    return 'blob:none'
  if (filter === 'tree')
    return 'tree:0'
  return null
}

/**
 * What a run found out about Git LFS, reported to the log, the JSON output and the CI summary.
 *
 * `pointers` are the synced paths whose content is a pointer; `materialized` are the ones this run
 * replaced with the real object. An empty `materialized` with a `note` is the ordinary outcome on
 * a machine without `git-lfs`, and says so instead of failing.
 */
export interface LfsFacts {
  mode: LfsMode
  pointers: RepoPath[]
  materialized: RepoPath[]
  note?: string
}
