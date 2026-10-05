import type { RepoPath } from '../domain'
import path from 'node:path'

/** All pipeline code works in repo-root-relative, slash-separated paths. */
export function toPosix(value: string): string {
  return value.replace(/\\/g, '/')
}

export function normalizeRepoPath(value: string): RepoPath {
  let out = toPosix(value).trim()
  out = out.replace(/^\.\//, '')
  out = out.replace(/\/{2,}/g, '/')
  out = out.replace(/\/+$/, '')
  return out
}

export function isUnderScope(candidate: RepoPath, scope: RepoPath): boolean {
  const file = normalizeRepoPath(candidate)
  const dir = normalizeRepoPath(scope)
  if (dir === '' || dir === '.')
    return true
  return file === dir || file.startsWith(`${dir}/`)
}

/** Longest matching sync dir, so `src` never swallows changes owned by `src/config`. */
export function scopeOf(candidate: RepoPath, scopes: RepoPath[]): RepoPath | null {
  let best: RepoPath | null = null
  for (const scope of scopes) {
    if (isUnderScope(candidate, scope) && (best === null || scope.length > best.length))
      best = scope
  }
  return best
}

export function parentOf(repoPath: RepoPath): RepoPath | null {
  const index = repoPath.lastIndexOf('/')
  if (index <= 0)
    return null
  return repoPath.slice(0, index)
}

export function ancestorsOf(repoPath: RepoPath): RepoPath[] {
  const result: RepoPath[] = []
  let current = parentOf(repoPath)
  while (current !== null) {
    result.push(current)
    current = parentOf(current)
  }
  return result
}

export function extensionOf(repoPath: RepoPath): string {
  return path.posix.extname(repoPath).toLowerCase()
}

export function joinRepoPath(base: string, repoPath: RepoPath): string {
  return path.join(base, ...normalizeRepoPath(repoPath).split('/').filter(Boolean))
}

/** File-name safe encoding for cache keys on Windows (`:` `\` `/` are illegal). */
export function toSafeFileName(value: string): string {
  return toPosix(value).replace(/[^\w.-]/g, '-')
}
