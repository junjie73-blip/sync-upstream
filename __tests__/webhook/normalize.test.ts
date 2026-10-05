import { normalizeDelivery } from '../../src/webhook/normalize'

describe('normalizeDelivery', () => {
  it('gitHub push：事件取自 X-GitHub-Event 头，ref 去掉 refs/heads/ 前缀', () => {
    const payload = { ref: 'refs/heads/main', repository: { full_name: 'org/repo' } }
    const result = normalizeDelivery('github', payload, { 'x-github-event': 'push' })
    expect(result).toEqual({ event: 'push', branch: 'main', ref: 'refs/heads/main' })
  })

  it('gitHub push 保留分支名中的斜杠', () => {
    const payload = { ref: 'refs/heads/feature/foo' }
    const result = normalizeDelivery('github', payload, { 'x-github-event': 'push' })
    expect(result.branch).toBe('feature/foo')
  })

  it('gitHub pull_request：无事件头时按 payload 形状推断，分支取 head.ref', () => {
    const payload = { pull_request: { head: { ref: 'topic-branch' } } }
    const result = normalizeDelivery('github', payload)
    expect(result.event).toBe('pull_request')
    expect(result.branch).toBe('topic-branch')
  })

  it('gitLab push：事件取 object_kind，分支取 ref', () => {
    const payload = { object_kind: 'push', ref: 'refs/heads/main', project_id: 1 }
    const result = normalizeDelivery('gitlab', payload)
    expect(result).toEqual({ event: 'push', branch: 'main', ref: 'refs/heads/main' })
  })

  it('gitLab merge_request：分支取 object_attributes.source_branch', () => {
    const payload = { object_kind: 'merge_request', object_attributes: { source_branch: 'fix-1' } }
    const result = normalizeDelivery('gitlab', payload)
    expect(result.event).toBe('merge_request')
    expect(result.branch).toBe('fix-1')
  })

  it('gitea 与 GitHub 形状一致', () => {
    const payload = { ref: 'refs/heads/main', repository: { full_name: 'org/repo' } }
    const result = normalizeDelivery('gitea', payload, { 'x-gitea-event': 'push' })
    expect(result.event).toBe('push')
    expect(result.branch).toBe('main')
  })

  it('bitbucket push：分支取 push.changes[0].new.name，事件推断为 repo:push', () => {
    const payload = {
      actor: { nickname: 'someone' },
      push: { changes: [{ new: { name: 'main' } }] },
    }
    const result = normalizeDelivery('bitbucket', payload)
    expect(result).toEqual({ event: 'repo:push', branch: 'main' })
  })

  it('bitbucket 事件优先取 X-Event-Key 头', () => {
    const payload = {
      actor: { nickname: 'someone' },
      pullrequest: { source: { branch: { name: 'feat-1' } } },
    }
    const result = normalizeDelivery('bitbucket', payload, { 'x-event-key': 'pullrequest:updated' })
    expect(result.event).toBe('pullrequest:updated')
    expect(result.branch).toBe('feat-1')
  })

  it('未知形状返回 event unknown / branch 空串', () => {
    expect(normalizeDelivery('github', { something: true })).toEqual({ event: 'unknown', branch: '' })
    expect(normalizeDelivery('gitlab', {})).toEqual({ event: 'unknown', branch: '' })
    expect(normalizeDelivery('bitbucket', {})).toEqual({ event: 'unknown', branch: '' })
  })
})
