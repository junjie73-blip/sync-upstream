import type { WebhookConfig } from '../../src/domain/webhook'
import { getValueByPath, shouldTriggerSync } from '../../src/webhook/filters'

function baseConfig(overrides: Partial<WebhookConfig> = {}): WebhookConfig {
  const config: WebhookConfig = {
    enable: true,
    port: 3000,
    path: '/webhook',
    secret: 's',
    allowedEvents: ['push'],
    triggerBranch: 'main',
    supportedPlatforms: ['github'],
    ...overrides,
  }
  return config
}

describe('getValueByPath', () => {
  const payload = { refs: { heads: { name: 'main' } }, list: [1, 2], deep: { a: { b: null } } }

  it('按点分路径逐层取值', () => {
    expect(getValueByPath(payload, 'refs.heads.name')).toBe('main')
    expect(getValueByPath(payload, 'list')).toBe(payload.list)
  })

  it('路径不存在或中途遇到非对象时返回 undefined，不抛异常', () => {
    expect(getValueByPath(payload, 'refs.heads.missing')).toBeUndefined()
    expect(getValueByPath(payload, 'refs.missing.deeper')).toBeUndefined()
    expect(getValueByPath(payload, 'deep.a.b.c')).toBeUndefined()
    expect(getValueByPath(payload, 'list.length')).toBe(2)
  })
})

describe('shouldTriggerSync', () => {
  it('分支不匹配拒绝', () => {
    const result = shouldTriggerSync(baseConfig(), { event: 'push', branch: 'dev' }, {})
    expect(result.accept).toBe(false)
    expect(result.reason).toContain('非触发分支')
  })

  it('事件不在 allowedEvents 拒绝', () => {
    const result = shouldTriggerSync(baseConfig(), { event: 'tag', branch: 'main' }, {})
    expect(result.accept).toBe(false)
    expect(result.reason).toContain('事件不在允许列表')
  })

  it('无规则配置时通过', () => {
    expect(shouldTriggerSync(baseConfig(), { event: 'push', branch: 'main' }, {}).accept).toBe(true)
  })

  it('eq/ne/contains/gt/lt 条件全部满足才通过', () => {
    const config = baseConfig({
      eventFilterConfig: {
        rules: [{
          eventType: 'push',
          conditions: [
            { fieldPath: 'repository.full_name', operator: 'eq', value: 'org/upstream' },
            { fieldPath: 'pusher.name', operator: 'ne', value: 'bot' },
            { fieldPath: 'commits', operator: 'contains', value: 'fix' },
            { fieldPath: 'size', operator: 'gt', value: 0 },
            { fieldPath: 'size', operator: 'lt', value: 100 },
          ],
        }],
      },
    })
    const payload = {
      repository: { full_name: 'org/upstream' },
      pusher: { name: 'human' },
      commits: ['fix', 'feat'],
      size: 10,
    }
    expect(shouldTriggerSync(config, { event: 'push', branch: 'main' }, payload).accept).toBe(true)

    const bad = { ...payload, pusher: { name: 'bot' } }
    const result = shouldTriggerSync(config, { event: 'push', branch: 'main' }, bad)
    expect(result.accept).toBe(false)
  })

  it('regex 规则命中与未命中', () => {
    const config = baseConfig({
      eventFilterConfig: {
        rules: [{
          eventType: 'push',
          conditions: [{ fieldPath: 'ref', operator: 'regex', value: '^refs/heads/(main|release/.*)$' }],
        }],
      },
    })
    expect(shouldTriggerSync(config, { event: 'push', branch: 'main' }, { ref: 'refs/heads/main' }).accept).toBe(true)
    expect(shouldTriggerSync(config, { event: 'push', branch: 'main' }, { ref: 'refs/heads/topic' }).accept).toBe(false)
  })

  it('非法正则不抛异常，以固定原因拒绝', () => {
    const config = baseConfig({
      eventFilterConfig: {
        rules: [{
          eventType: 'push',
          conditions: [{ fieldPath: 'ref', operator: 'regex', value: '(unclosed' }],
        }],
      },
    })
    const result = shouldTriggerSync(config, { event: 'push', branch: 'main' }, { ref: 'refs/heads/main' })
    expect(result.accept).toBe(false)
    expect(result.reason).toBe('过滤规则正则无效')
  })

  it('配置了规则的事件必须至少命中一条', () => {
    const config = baseConfig({
      eventFilterConfig: {
        rules: [
          { eventType: 'push', conditions: [{ fieldPath: 'a', operator: 'eq', value: 1 }] },
          { eventType: 'push', conditions: [{ fieldPath: 'b', operator: 'eq', value: 2 }] },
          { eventType: 'pull_request', conditions: [] },
        ],
      },
    })
    expect(shouldTriggerSync(config, { event: 'push', branch: 'main' }, { a: 1 }).accept).toBe(true)
    expect(shouldTriggerSync(config, { event: 'push', branch: 'main' }, { c: 3 }).accept).toBe(false)
    // 该事件未配置规则则默认放行（pull_request 规则只约束 pull_request 事件本身）
    expect(shouldTriggerSync(config, { event: 'push', branch: 'main' }, { b: 2 }).accept).toBe(true)
  })
})
