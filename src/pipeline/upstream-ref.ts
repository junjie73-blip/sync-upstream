import type { FetchConfig, RetryConfig } from '../domain'
import type { FetchOptions, GitRepository } from '../git/repository'
import { filterArg } from '../domain'
import { GitError } from '../errors'
import { redacted } from '../git/url'
import { withRetry } from '../retry'

/** Dedicated remote so the tool never rewrites the user's `origin`. */
export const UPSTREAM_REMOTE = 'sync-upstream'

/**
 * What a source ref can be. `upstreamBranch` keeps its name for compatibility, but the value
 * it holds is any git revision the upstream offers: a branch, a tag, or a commit.
 */
export type SourceKind = 'branch' | 'tag' | 'revision'

export interface SourceRef {
  /** Verbatim config/CLI value, e.g. `refs/tags/v1.2.3`. */
  input: string
  kind: SourceKind
  /** Name without the `refs/heads/` / `refs/tags/` decoration. */
  name: string
}

const REVISION_PATTERN = /^[0-9a-f]{7,40}$/i

/**
 * Classify the configured source. `refs/…` spellings are explicit and win; a bare hex string
 * that contains a letter is read as a commit — a branch really named `20240101` stays a branch,
 * and somebody who wants `deadbeef` as a commit can write `refs/…` or just include a letter.
 * Everything else is a branch, which is what every existing config means.
 */
export function parseSourceRef(input: string): SourceRef {
  const value = input.trim()
  if (value.startsWith('refs/heads/'))
    return { input: value, kind: 'branch', name: value.slice('refs/heads/'.length) }
  if (value.startsWith('refs/tags/'))
    return { input: value, kind: 'tag', name: value.slice('refs/tags/'.length) }
  if (REVISION_PATTERN.test(value) && /[a-f]/i.test(value))
    return { input: value, kind: 'revision', name: value }
  // `refs/changes/…`, `refs/pull/…`: fetched verbatim and read back from FETCH_HEAD.
  return { input: value, kind: 'branch', name: value }
}

const KIND_WORD: Record<SourceKind, string> = {
  branch: '分支',
  tag: '标签',
  revision: '提交',
}

/** Operator-facing description used by logs, reports and error messages. */
export function describeSource(source: SourceRef): string {
  const shown = source.kind === 'revision' ? source.name.slice(0, 8) : source.name
  return `${KIND_WORD[source.kind]} ${shown}`
}

/**
 * The kind as it actually resolved: `v1.8.0` is spelled like a branch and only turns out to be
 * a tag once the fetch lands in the tag namespace, so reports ask the fetched ref rather than
 * the config string.
 */
export function resolvedKind(source: SourceRef, upstreamRef: string | null): SourceKind {
  if (source.kind === 'branch' && upstreamRef?.endsWith(`/tags/${source.name}`))
    return 'tag'
  return source.kind
}

/** Refs that can represent "the source revision we last fetched", in preference order. */
export function fetchedRefCandidates(remote: string, source: SourceRef): string[] {
  if (source.kind === 'tag') {
    return [
      `refs/remotes/${remote}/tags/${source.name}`,
      'FETCH_HEAD',
      `refs/tags/${source.name}`,
    ]
  }
  if (source.kind === 'revision') {
    // No FETCH_HEAD here: a sha we never fetched must not be "found" in whatever an unrelated
    // fetch left behind — only our own namespace or the object itself count.
    return [
      `refs/remotes/${remote}/revisions/${source.name}`,
      source.name,
    ]
  }
  return [
    `refs/remotes/${remote}/${source.name}`,
    `${remote}/${source.name}`,
    // A version-looking name is usually a tag, and the fallback below fetches it as one.
    `refs/remotes/${remote}/tags/${source.name}`,
    'FETCH_HEAD',
  ]
}

/**
 * What to hand `git fetch <remote>` for this source. Every kind writes into our own
 * `refs/remotes/<remote>/…` namespace — never the user's `refs/tags/` — and the leading `+`
 * keeps a force-pushed upstream from wedging the next sync.
 *
 * Naming `refs/heads/…` explicitly is also what makes `-b v1.8.0` work: as a bare name git
 * happily resolves tags through FETCH_HEAD alone, which no later command can re-read. With the
 * heads refspec the tag spelling fails fast and `fetchSource` retries it as a tag.
 */
export function sourceRefspec(remote: string, source: SourceRef): string {
  if (source.kind === 'tag')
    return `+refs/tags/${source.name}:refs/remotes/${remote}/tags/${source.name}`
  if (source.kind === 'revision')
    return `+${source.name}:refs/remotes/${remote}/revisions/${source.name}`
  // `refs/pull/42/head` and friends are already complete refs; fetch them verbatim.
  if (source.name.startsWith('refs/'))
    return source.name
  return `+refs/heads/${source.name}:refs/remotes/${remote}/${source.name}`
}

/**
 * The first candidate that exists locally, or null when nothing has been fetched yet.
 *
 * A bare commit name is the one candidate `git rev-parse --verify` cannot be trusted with:
 * any well-formed 40-hex sha "verifies" whether or not the object is in the store, so the
 * commit candidate asks for the object itself instead of for a ref.
 */
export async function findSourceRef(
  git: GitRepository,
  remote: string,
  source: SourceRef,
): Promise<string | null> {
  for (const candidate of fetchedRefCandidates(remote, source)) {
    const exists = candidate === source.name
      ? await git.objectExists(candidate)
      : await git.refExists(candidate)
    if (exists)
      return candidate
  }
  return null
}

/**
 * Fetch the source into the dedicated remote.
 *
 * A commit that is already present locally needs no fetch at all: forks share history, so the
 * object usually arrived with the branch that was synced earlier. Servers that refuse
 * `uploadpack.allowAnySHA1InWant` (GitHub and Gitea do by default) cannot serve a bare sha
 * either, so the local check is also the only path that works there — the error says which.
 *
 * `fetchConfig` decides how much of the repository the fetch asks for. Nothing here treats a
 * server that cannot filter as an error: git warns on stderr and sends everything, and the sync
 * proceeds, which is the right outcome for a mirror behind a proxy that strips the capability.
 */
export async function fetchSource(
  git: GitRepository,
  remote: string,
  source: SourceRef,
  upstreamRepo: string,
  retryConfig?: RetryConfig,
  fetchConfig?: FetchConfig,
): Promise<void> {
  if (source.kind === 'revision' && await git.objectExists(source.name))
    return

  const options: FetchOptions = {
    filter: fetchConfig ? filterArg(fetchConfig.filter) : null,
    depth: fetchConfig?.depth,
    tags: fetchConfig?.tags,
  }
  const refspec = sourceRefspec(remote, source)
  const action = `拉取 ${redacted(upstreamRepo)} 的${describeSource(source)}`
  const retry = retryConfig ?? { maxRetries: 0, initialDelay: 0, backoffFactor: 1 }
  try {
    await withRetry(() => git.fetch(remote, refspec, action, options), { ...retry, isRetryable: isNetworkFailure })
  }
  catch (error) {
    // `-b v1.8.0` is how people write a tag, and nothing in the config says otherwise;
    // a name that git cannot find as a branch is retried as one before it becomes an error.
    // A network failure is not "that ref does not exist", so it must not pay for a second fetch.
    if (!isNetworkFailure(error as Error) && await fetchAsTagFallback(git, remote, source, options))
      return
    const shallow = options.depth
      ? `（本次抓取深度为 ${options.depth} 个提交，更早的历史不在本地：去掉 fetchConfig.depth 或加大它）`
      : ''
    if (source.kind === 'tag') {
      throw new GitError(
        `${action} 失败：上游 ${redacted(upstreamRepo)} 没有标签 ${source.name}${shallow}`,
        error as Error,
      )
    }
    if (source.kind === 'revision') {
      throw new GitError(
        `${action} 失败：本地没有提交 ${source.name.slice(0, 8)}，且 ${redacted(upstreamRepo)} 不支持按提交抓取`
        + `（服务端需开启 uploadpack.allowAnySHA1InWant；GitHub 默认关闭）${
          shallow}`,
        error as Error,
        { hint: '改用包含该提交的分支或标签，或先把上游整体抓取一次' },
      )
    }
    const asTag = canTryAsTag(source) ? '或标签' : ''
    throw new GitError(`${action} 失败：上游 ${redacted(upstreamRepo)} 没有分支${asTag} ${source.name}${shallow}`, error as Error)
  }
}

/**
 * `refs/pull/1/head` is already a full ref, and `refs/heads/x` says "a branch, on purpose" —
 * only an undecorated name can plausibly mean "a tag with that name".
 */
function canTryAsTag(source: SourceRef): boolean {
  return source.kind === 'branch' && !source.input.startsWith('refs/')
}

async function fetchAsTagFallback(
  git: GitRepository,
  remote: string,
  source: SourceRef,
  options: FetchOptions,
): Promise<boolean> {
  if (!canTryAsTag(source))
    return false
  try {
    await git.fetch(remote, sourceRefspec(remote, { ...source, kind: 'tag' }), undefined, options)
    return true
  }
  catch {
    return false
  }
}

const NETWORK = /网络|network|connect|resolve host|timed out|timeout|RPC failed|early EOF|The remote end/i

function isNetworkFailure(error: Error): boolean {
  return NETWORK.test(error.message)
}

/**
 * Same lookup as `findSourceRef`, but a missing ref is a hard error: a sync run has nothing to
 * apply without it.
 */
export async function requireSourceRef(
  git: GitRepository,
  remote: string,
  source: SourceRef,
  upstreamRepo: string,
): Promise<string> {
  const found = await findSourceRef(git, remote, source)
  if (found)
    return found
  const where = source.kind === 'revision' ? '本地既没有该对象，也没有抓到它' : '本地引用与 FETCH_HEAD 都不存在'
  throw new GitError(
    `${redacted(upstreamRepo)} 中没有可用的${describeSource(source)} ${source.name}（${where}）`,
  )
}
