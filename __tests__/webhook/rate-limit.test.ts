import { logger } from '../../src/logger'
import { isIpAllowed, TokenBucket } from '../../src/webhook/rate-limit'

describe('tokenBucket', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('桶容量内放行，超出后拒绝', () => {
    const bucket = new TokenBucket(2)
    expect(bucket.take('ip-a')).toBe(true)
    expect(bucket.take('ip-a')).toBe(true)
    expect(bucket.take('ip-a')).toBe(false)
  })

  it('按时间补充令牌（1/s 每秒恢复一个）', () => {
    const bucket = new TokenBucket(1)
    expect(bucket.take('ip-a')).toBe(true)
    expect(bucket.take('ip-a')).toBe(false)
    jest.advanceTimersByTime(500)
    expect(bucket.take('ip-a')).toBe(false)
    jest.advanceTimersByTime(600)
    expect(bucket.take('ip-a')).toBe(true)
    expect(bucket.take('ip-a')).toBe(false)
  })

  it('补充不超过容量上限', () => {
    const bucket = new TokenBucket(2)
    bucket.take('ip-a')
    bucket.take('ip-a')
    jest.advanceTimersByTime(60_000)
    expect(bucket.take('ip-a')).toBe(true)
    expect(bucket.take('ip-a')).toBe(true)
    expect(bucket.take('ip-a')).toBe(false)
  })

  it('按 key 隔离计数', () => {
    const bucket = new TokenBucket(1)
    expect(bucket.take('ip-a')).toBe(true)
    expect(bucket.take('ip-b')).toBe(true)
    expect(bucket.take('ip-a')).toBe(false)
  })

  it('maxPerSecond <= 0 时一律拒绝', () => {
    const bucket = new TokenBucket(0)
    expect(bucket.take('ip-a')).toBe(false)
  })

  it('sweep 清理闲置 key，保留活跃 key', () => {
    const bucket = new TokenBucket(5)
    bucket.take('idle')
    jest.advanceTimersByTime(61_000)
    bucket.take('active')
    expect(bucket.sweep(60_000)).toBe(1)
    // idle 已被重置：重新计满桶
    expect(bucket.take('idle')).toBe(true)
  })

  it('不注册定时器：take/sweep 后计时器数量为 0（unref 安全）', () => {
    const bucket = new TokenBucket(1)
    expect(bucket.take('x')).toBe(true)
    bucket.sweep()
    expect(jest.getTimerCount()).toBe(0)
  })
})

describe('isIpAllowed', () => {
  it('空白名单放行所有 IP', () => {
    expect(isIpAllowed('1.2.3.4', [])).toBe(true)
  })

  it('精确匹配 IPv4/IPv6 字面量', () => {
    expect(isIpAllowed('203.0.113.10', ['203.0.113.10'])).toBe(true)
    expect(isIpAllowed('203.0.113.11', ['203.0.113.10'])).toBe(false)
    expect(isIpAllowed('::1', ['::1'])).toBe(true)
  })

  it('CIDR 网段匹配', () => {
    expect(isIpAllowed('10.1.2.3', ['10.0.0.0/8'])).toBe(true)
    expect(isIpAllowed('11.1.2.3', ['10.0.0.0/8'])).toBe(false)
    expect(isIpAllowed('192.168.1.7', ['192.168.1.0/24'])).toBe(true)
    expect(isIpAllowed('192.168.2.7', ['192.168.1.0/24'])).toBe(false)
  })

  it('CIDR 边界：/32 精确、/0 全放行、网络位非零也能正确掩码', () => {
    expect(isIpAllowed('8.8.8.8', ['8.8.8.8/32'])).toBe(true)
    expect(isIpAllowed('8.8.8.9', ['8.8.8.8/32'])).toBe(false)
    expect(isIpAllowed('255.255.255.255', ['128.0.0.0/0'])).toBe(true)
    expect(isIpAllowed('10.0.0.5', ['10.0.0.6/24'])).toBe(true)
  })

  it('非法 IP 对 CIDR 条目不匹配，但不影响其他条目', () => {
    expect(isIpAllowed('not-an-ip', ['10.0.0.0/8', 'not-an-ip'])).toBe(true)
    expect(isIpAllowed('not-an-ip', ['10.0.0.0/8'])).toBe(false)
  })

  it('非法 CIDR 条目被忽略并记录 warn', () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {})
    // 非法条目被跳过，合法的 10.2.0.0/16 仍然生效
    expect(isIpAllowed('10.2.1.1', ['abc/8', '10.0.0.0/33', '10.0.0/8', '10.0.0.0/x', '10.2.0.0/16'])).toBe(true)
    // 所有条目都非法（或与客户端不匹配）时拒绝
    expect(isIpAllowed('10.1.2.3', ['abc/8', '10.0.0.0/33', '10.0.0/8', '10.0.0.0/x', '10.2.0.0/16'])).toBe(false)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
