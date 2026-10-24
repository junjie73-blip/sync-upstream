import type { AuthConfig } from '../domain'
import path from 'node:path'
import process from 'node:process'
import { AuthType } from '../domain'
import { AuthenticationError, GitError, TimeoutError, toError } from '../errors'
import { t } from '../i18n'

/** scp-style address (`git@host:org/repo.git`) is not a URL and needs rewriting first. */
export function toClonableUrl(rawUrl: string, auth?: AuthConfig): string {
  const trimmed = rawUrl.trim()
  if (trimmed === '')
    throw new AuthenticationError(t('e.repoUrlEmpty'))

  const withAuth = (base: string, username: string, secret: string): string => {
    const url = new URL(base)
    url.username = encodeURIComponent(username)
    url.password = encodeURIComponent(secret)
    return url.toString()
  }

  let resolved = trimmed
  if (/^[\w.-]+@[^:/]+:/.test(resolved) && !resolved.includes('://')) {
    // scp-style `git@host:org/repo.git` must become `ssh://git@host/org/repo.git`;
    // keeping the colon makes git parse the path as a port number.
    resolved = `ssh://${resolved.replace(':', '/')}`
  }

  if (!auth || auth.type === AuthType.SSH)
    return resolved

  const secret = auth.type === AuthType.PAT ? auth.token : auth.password
  const username = auth.type === AuthType.PAT ? 'git' : auth.username
  if (!username || !secret) {
    throw new AuthenticationError(t('e.authNeedsPair', { type: auth.type }), undefined, { type: auth.type })
  }

  try {
    return withAuth(resolved, username, secret)
  }
  catch (error) {
    throw new AuthenticationError(t('e.authEmbedFailed', { url: redacted(trimmed) }), toError(error))
  }
}

/**
 * Never let a credential-bearing URL reach logs or error messages. Both spellings occur in
 * the wild: `https://user:token@host` and `https://<token>@host` (GitHub PATs, GitLab
 * `oauth2@`, Bitbucket app passwords), so everything before the `@` goes.
 */
export function redacted(url: string): string {
  return url.replace(/\/\/[^/@\s]+@/g, '//***@')
}

export function parseRepoUrl(rawUrl: string): URL | null {
  try {
    return new URL(toClonableUrl(rawUrl))
  }
  catch {
    return null
  }
}

export function isLocalPath(url: string, cwd = process.cwd()): string | null {
  const trimmed = url.trim()
  if (/^[a-z]:[\\/]/i.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../')) {
    return path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(cwd, trimmed)
  }
  return null
}

export function describeError(error: unknown): string {
  const message = toError(error).message
  if (/Authentication failed|permission denied \(public key\)|invalid username or password/i.test(message)) {
    return `认证失败，请检查仓库权限或 --auth 配置: ${redacted(message)}`
  }
  if (/Could not resolve host|timed out|unable to access|Connection refused/i.test(message)) {
    return `网络不可达: ${redacted(message)}`
  }
  if (/couldn't find remote ref|not found in upstream/i.test(message)) {
    return `远端分支不存在: ${redacted(message)}`
  }
  if (/Please commit your changes|would be overwritten|local changes/i.test(message)) {
    return `工作区存在未提交改动，git 拒绝了本次操作: ${message}`
  }
  return message
}

export function wrapGitError(action: string, error: unknown): GitError | TimeoutError {
  const original = toError(error)
  const isTimeout = /timed? ?out|ETIMEDOUT/i.test(original.message)
  const detail = describeError(original)
  // The mapped hint is only appended when it says something the raw git text does not.
  const hint = detail === original.message ? '' : `（${detail}）`
  return isTimeout
    ? new TimeoutError(`${action} 超时${hint}`, original, { detail })
    : new GitError(`${action} 失败${hint}`, original, { detail })
}
