import type { PrConfig } from '../domain'
import type { GitRepository } from '../git/repository'

/** What a PR-mode run produced: the branch, whether it reached the remote, and where to open it. */
export interface PullRequestFacts {
  /** Branch the sync commits landed on. The target branch itself never moved. */
  branch: string
  baseBranch: string
  remote: string
  pushed: boolean
  /** Compare page the reviewer can open; null for a local-path remote or an unknown host. */
  url: string | null
  /** Set when `gh`/`glab` was asked to open the PR. */
  tool?: string
  created?: boolean
  /** Anything the operator should read: a failed push, a missing CLI, a reused branch. */
  note?: string
}

/**
 * Branch name for a PR-mode run.
 *
 * `{target}` and `{date}` keep the branch self-describing (`sync-upstream/company-2026-10-22`),
 * which matters most when somebody finds it weeks later. An existing branch of the same name is
 * suffixed rather than reused: a stale PR branch still carries the previous run's commit, and
 * pushing on top of it would quietly widen an open pull request.
 */
export function prBranchName(config: PrConfig | undefined, targetBranch: string, today = new Date()): string {
  const pattern = config?.branchPattern?.trim() || 'sync-upstream/{target}-{date}'
  const stamp = `${today.getFullYear()}${two(today.getMonth() + 1)}${two(today.getDate())}`
  return sanitizeBranch(pattern
    .replace(/\{target\}/g, slug(targetBranch))
    .replace(/\{date\}/g, stamp)
    .replace(/[\\/]+/g, '/'))
}

/** `git branch -a` plus `-2`, `-3`, … until the name is free. */
export async function uniqueBranchName(git: GitRepository, base: string): Promise<{ branch: string, reusedSuffix: boolean }> {
  if (!(await git.branchExists(base)))
    return { branch: base, reusedSuffix: false }
  for (let index = 2; index < 100; index++) {
    const candidate = `${base}-${index}`
    if (!(await git.branchExists(candidate)))
      return { branch: candidate, reusedSuffix: true }
  }
  return { branch: `${base}-${Date.now()}`, reusedSuffix: true }
}

/**
 * Compare page for the pushed branch, per host.
 *
 * Only the three hosts whose URL layout is stable enough to build blind are handled; anything
 * else (a self-hosted Forgejo on a path prefix, a local path used in tests) returns null and the
 * caller prints the branch name instead, which is always correct.
 */
export function compareUrl(remoteUrl: string | undefined, base: string, head: string): string | null {
  if (!remoteUrl)
    return null
  const web = webRepoUrl(remoteUrl)
  if (!web)
    return null
  if (web.includes('//gitlab.') || web.includes('/gitlab/'))
    return `${web}/-/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
  if (web.includes('//bitbucket.'))
    return `${web}/pull-requests/new?source=${encodeURIComponent(head)}&dest=${encodeURIComponent(base)}%3E%3E${encodeURIComponent(head)}`
  if (web.includes('//gitee.'))
    return `${web}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
  if (web.includes('//github.'))
    return `${web}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
  return null
}

/** ssh/scp-style and https remotes all reduce to the browser URL of the repository. */
export function webRepoUrl(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim().replace(/\.git$/i, '')
  if (/\s/.test(trimmed) || /^[A-Z]:[\\/]/i.test(trimmed) || trimmed.startsWith('/'))
    return null

  const scp = /^(?:[^@/]+@)?([\w.-]+):([\w./-]+)$/.exec(trimmed)
  if (scp && !trimmed.includes('://'))
    return `https://${scp[1]}/${scp[2].replace(/^\/+/, '')}`

  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
    // `ssh://` and `git://` are how the clone URL is written; the web address is the same
    // host and path over https, and the credentials in the userinfo are simply dropped.
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol))
      return null
    return `https://${url.host}${url.pathname.replace(/\/+$/, '')}`
  }
  catch {
    return null
  }
}

function two(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * Branch names may not contain space, `~^:?*[\`, consecutive dots or a trailing `.`/`/`,
 * and refs must not nest (`a` and `a/b` cannot both exist), so everything odd becomes `-`.
 */
export function slug(value: string): string {
  return value
    .trim()
    .replace(/[\s~^:?*[\\\]]+/g, '-')
    .replace(/\.{2,}/g, '-')
    .replace(/\/+/g, '-')
    .replace(/^-+|-+$|\.+$/g, '')
    || 'sync'
}

function sanitizeBranch(value: string): string {
  return value
    .replace(/[\s~^:?*[\]\\]+/g, '-')
    .replace(/\.{2,}/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/\/$/, '')
    .replace(/\/\.$/, '')
    .replace(/^\/+/, '')
    // A ref may not end in `.` either; templates written by hand get that forgiving.
    .replace(/\.+$/, '')
}
