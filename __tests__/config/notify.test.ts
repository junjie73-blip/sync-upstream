import { resolveConfig } from '../../src/config/resolve'

const BASE = {
  upstreamRepo: 'https://git.example.com/org/upstream.git',
  upstreamBranch: 'main',
  companyBranch: 'company',
  syncDirs: ['src/config'],
  nonInteractive: true,
}

function resolve(extra: Record<string, unknown>) {
  return resolveConfig({ ...BASE, ...extra })
}

function rejection(extra: Record<string, unknown>): string {
  try {
    resolve(extra)
  }
  catch (error) {
    return (error as Error).message
  }
  throw new Error('预期校验失败，实际通过了')
}

describe('notifyConfig 归一化', () => {
  it('没写通知时保持关闭，但字段齐备', () => {
    const { config } = resolve({})
    expect(config.notifyConfig).toMatchObject({ enable: false, channels: [], timeoutMs: 5000, retries: 2 })
  })

  it('只写渠道时其余字段沿用默认值', () => {
    const { config } = resolve({ notifyConfig: { enable: true, channels: ['slack'], slackUrl: 'https://hooks.slack.com/services/T/B/X' } })
    expect(config.notifyConfig).toMatchObject({
      enable: true,
      channels: ['slack'],
      events: ['success', 'conflict', 'failure', 'undo'],
      timeoutMs: 5000,
      retries: 2,
      includeDetails: true,
    })
  })

  it('notify / notifications 别名可用', () => {
    const { config, warnings } = resolve({ notify: { enable: true, channels: ['stdout'] } })
    expect(config.notifyConfig?.enable).toBe(true)
    expect(warnings.some(warning => warning.includes('别名'))).toBe(true)
  })

  it('规范拼写的 notifyConfig 不会被报成未知项', () => {
    const { warnings } = resolve({ notifyConfig: { enable: true, channels: ['stdout'] }, webhookConfig: { enable: false } as never })
    expect(warnings.filter(warning => warning.includes('未识别'))).toEqual([])
  })

  it('未知渠道 / 空渠道 / 非法超时 / 越界重试 / 非 http 地址各自报错', () => {
    expect(rejection({ notifyConfig: { enable: true, channels: ['sms'] } })).toContain('sms')
    expect(rejection({ notifyConfig: { enable: true, channels: [] } })).toContain('不能为空')
    expect(rejection({ notifyConfig: { enable: true, channels: ['http'], events: ['done'] } })).toContain('done')
    expect(rejection({ notifyConfig: { enable: true, channels: ['http'], timeoutMs: 100 } })).toContain('timeoutMs')
    expect(rejection({ notifyConfig: { enable: true, channels: ['http'], retries: 9 } })).toContain('retries')
    expect(rejection({ notifyConfig: { enable: true, channels: ['http'], url: 'ftp://x/y' } })).toContain('notifyConfig.url')
    expect(rejection({ notifyConfig: { enable: true, channels: ['http'], url: 'https://ok/x', wecomUrl: 'nope' } })).toContain('notifyConfig.wecomUrl')
    expect(rejection({ notifyConfig: { enable: true, channels: ['http'], headers: [] as never } })).toContain('headers')
  })

  it('关闭时不校验内容，避免历史配置阻塞运行', () => {
    expect(() => resolve({ notifyConfig: { enable: false, channels: ['sms'], timeoutMs: 1 } })).not.toThrow()
  })
})
