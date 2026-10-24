/**
 * One entry of the optional `upstreams` list: a source this run also syncs, on top of the
 * single upstream the top-level keys describe. Every field is optional and falls back to the
 * top-level value, so `[{ branch: 'dev' }]` means "also take dev from the same repo".
 */
export interface UpstreamSource {
  /** Upstream repository URL; defaults to `upstreamRepo`. */
  repo?: string
  /** Branch, tag, or commit; defaults to `upstreamBranch`. */
  branch?: string
  /** Directories this source owns; defaults to `syncDirs`. */
  dirs?: string[]
  /** Commit message for this source's commit; defaults to `commitMessage`. */
  message?: string
}
