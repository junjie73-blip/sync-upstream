import type { WebhookPlatform } from '../domain/webhook'
import { getHeader } from './signature'

/**
 * 归一化后的投递信息：事件名 + 短分支名（去掉 refs/heads/ 前缀），ref 保留原始引用
 */
export interface NormalizedDelivery {
  event: string
  branch: string
  ref?: string
}

/**
 * 去掉 git 引用前缀，保留分支名里的斜杠（如 feature/foo）
 */
function stripRefPrefix(ref: string): string {
  for (const prefix of ['refs/heads/', 'refs/tags/']) {
    if (ref.startsWith(prefix))
      return ref.slice(prefix.length)
  }
  return ref
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * GitHub/Gitea 风格的 payload 解析：push 用 ref，pull_request 用 head.ref。
 * 事件优先取平台标识头，缺失时按 payload 形状推断。
 */
function normalizeGitHubLike(
  payload: Record<string, any>,
  eventHeader: string | undefined,
): { event: string, branch: string, ref?: string } {
  const ref = asString(payload.ref)
  const hasPullRequest = payload.pull_request !== undefined && payload.pull_request !== null
  const event = eventHeader
    ?? (hasPullRequest ? 'pull_request' : ref?.startsWith('refs/') ? 'push' : 'unknown')

  let branch = ''
  if (event === 'pull_request') {
    branch = asString(payload.pull_request?.head?.ref) ?? ''
  }
  else if (ref) {
    branch = stripRefPrefix(ref)
  }
  return branch || event !== 'unknown' ? { event, branch, ref } : { event: 'unknown', branch: '' }
}

/**
 * 按平台把原始 payload + 请求头归一化成 { event, branch, ref? }。
 * 无法识别时返回 event 'unknown'、branch ''。
 */
export function normalizeDelivery(
  platform: WebhookPlatform,
  payload: Record<string, any>,
  headers: NodeJS.Dict<string | string[]> = {},
): NormalizedDelivery {
  switch (platform) {
    case 'github':
      return normalizeGitHubLike(payload, getHeader(headers, 'x-github-event'))
    case 'gitea':
      return normalizeGitHubLike(payload, getHeader(headers, 'x-gitea-event') ?? getHeader(headers, 'x-github-event'))
    case 'gitlab': {
      const event = asString(payload.object_kind) ?? getHeader(headers, 'x-gitlab-event') ?? 'unknown'
      const ref = asString(payload.ref)
      let branch = ''
      if (event === 'merge_request') {
        branch = asString(payload.object_attributes?.source_branch) ?? ''
      }
      else if (ref) {
        branch = stripRefPrefix(ref)
      }
      return branch || event !== 'unknown' ? { event, branch, ref } : { event: 'unknown', branch: '' }
    }
    case 'bitbucket': {
      const hasPush = payload.push !== undefined && payload.push !== null
      const hasPullRequest = payload.pullrequest !== undefined && payload.pullrequest !== null
      const event = getHeader(headers, 'x-event-key')
        ?? (hasPush ? 'repo:push' : hasPullRequest ? 'pullrequest:created' : 'unknown')

      let branch = ''
      if (hasPush) {
        const changes = Array.isArray(payload.push?.changes) ? payload.push.changes : []
        branch = asString(changes[0]?.new?.name) ?? ''
      }
      else if (hasPullRequest) {
        branch = asString(payload.pullrequest?.source?.branch?.name) ?? ''
      }
      return { event, branch }
    }
    default:
      return { event: 'unknown', branch: '' }
  }
}
