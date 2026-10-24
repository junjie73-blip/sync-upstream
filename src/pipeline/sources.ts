import type { SyncConfig, UpstreamSource } from '../domain'
import type { SourceRef } from './upstream-ref'
import crypto from 'node:crypto'
import { SYNC_STATE_FILE } from './sync-state'
import { parseSourceRef, UPSTREAM_REMOTE } from './upstream-ref'

/**
 * One resolved sync source. Fan-in (`upstreams: [...]`) turns one run into a list of these,
 * each with its own remote, its own incremental state file, and therefore its own commit.
 */
export interface SyncSource {
  /** Position in the configured list; the first one keeps the legacy names. */
  index: number
  repo: string
  /** Verbatim configured ref (branch, tag, commit, or `refs/…`). */
  ref: string
  source: SourceRef
  dirs: string[]
  commitMessage: string
  /** Dedicated remote this source is fetched into. */
  remote: string
  /** State file basename, relative to the repository root. */
  stateFile: string
  /** Short human label: `upstream@main`. */
  label: string
}

export { SYNC_STATE_FILE }

/** Repo-name part of a label, so logs stay readable when the URL is long. */
export function repoDisplayName(url: string): string {
  const clean = url.trim().replace(/[\\/]+$/, '').replace(/\.git$/i, '')
  // Windows local paths (and `file:///…` URLs of a local clone) use backslashes; splitting on
  // those too keeps `J:\repos\upstream` from becoming a 20-character label.
  const last = clean.split(/[/:\\]/).pop() ?? clean
  return last.trim() || clean
}

function shortHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 8)
}

function sanitize(value: string): string {
  const safe = value.replace(/refs\/(heads|tags)\//, '').replace(/[^\w.-]+/g, '_').slice(0, 40)
  return safe.replace(/^[._-]+/, '') || 'ref'
}

/**
 * Which file holds this source's incremental state.
 *
 * A single upstream keeps writing `.sync-state.json`, exactly as every previous release did.
 * Fan-in gives every source its own file — the state maps a path to the blob it was synced
 * from, so two upstreams sharing one file would mark each other's work "already synced" and
 * silently drop half of the second upstream's changes.
 */
export function stateFileFor(repo: string, ref: string, fanIn: boolean): string {
  if (!fanIn)
    return SYNC_STATE_FILE
  const source = parseSourceRef(ref)
  return `.sync-state-${sanitize(source.name)}-${shortHash(`${repo}\u0000${ref}`)}.json`
}

/**
 * Remote name per *repository*, not per source: two branches of one upstream are fetched by the
 * same remote (git keys its refspec on the remote), while a second upstream must not overwrite
 * the first one's URL. The first stays `sync-upstream` so existing setups are unaffected.
 */
function remoteNameFor(index: number): string {
  return index === 0 ? UPSTREAM_REMOTE : `${UPSTREAM_REMOTE}-${index + 1}`
}

/**
 * Expand the config into the list of sources this run works through. Without `upstreams` the
 * result is the single top-level source, byte-for-byte the behaviour of earlier releases.
 */
export function sourcesOf(config: SyncConfig): SyncSource[] {
  const extra = (config.upstreams ?? []).filter(Boolean)
  const fanIn = extra.length > 0
  const entries: Array<UpstreamSource & { _index: number }> = fanIn
    ? extra.map((item, index) => ({ ...item, _index: index }))
    : [{ _index: 0 }]

  const remoteIndexOfRepo = new Map<string, number>()
  return entries.map((item) => {
    const repo = (item.repo ?? config.upstreamRepo).trim()
    const ref = (item.branch ?? config.upstreamBranch).trim() || config.upstreamBranch
    const dirs = item.dirs && item.dirs.length > 0 ? item.dirs : config.syncDirs
    const source = parseSourceRef(ref)
    if (!remoteIndexOfRepo.has(repo))
      remoteIndexOfRepo.set(repo, remoteIndexOfRepo.size)
    const remote = remoteNameFor(remoteIndexOfRepo.get(repo)!)
    return {
      index: item._index,
      repo,
      ref,
      source,
      dirs,
      commitMessage: (item.message && item.message.trim()) || config.commitMessage,
      remote,
      stateFile: stateFileFor(repo, ref, fanIn),
      label: `${repoDisplayName(repo)}@${source.kind === 'revision' ? source.name.slice(0, 8) : source.name}`,
    }
  })
}

/** True when the run has more than one source, which changes names, output, and warnings. */
export function isFanIn(config: SyncConfig): boolean {
  return (config.upstreams ?? []).filter(Boolean).length > 0
}
