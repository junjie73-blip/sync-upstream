import type { RawSyncConfig } from '../../src/domain'
import {
  CANONICAL_KEYS,
  coerceValue,
  CONFIG_ALIASES,
  isKnownKey,
  normalizeConfigKeys,
  unknownKeys,
} from '../../src/config/normalize'

describe('coerceValue', () => {
  it('数字别名接受数字与数字字符串，其余报错', () => {
    expect(coerceValue(12, 'number', 'maxParallelFiles')).toEqual({ value: 12 })
    expect(coerceValue('7', 'number', 'maxParallelFiles')).toEqual({ value: 7 })
    expect(coerceValue('abc', 'number', 'maxParallelFiles').error).toContain('需要数字')
  })

  it('布尔别名兼容 CLI 的 true/false/1/0 文本', () => {
    expect(coerceValue(true, 'boolean', 'push')).toEqual({ value: true })
    expect(coerceValue('true', 'boolean', 'push')).toEqual({ value: true })
    expect(coerceValue('0', 'boolean', 'push')).toEqual({ value: false })
    expect(coerceValue('maybe', 'boolean', 'push').error).toContain('需要布尔值')
  })

  it('字符串数组别名兼容逗号分隔文本', () => {
    expect(coerceValue(['a', 'b'], 'string[]', 'dirs')).toEqual({ value: ['a', 'b'] })
    expect(coerceValue('a, b ,, c', 'string[]', 'dirs')).toEqual({ value: ['a', 'b', 'c'] })
    expect(coerceValue(42, 'string[]', 'dirs').error).toContain('需要字符串数组')
  })

  it('null / undefined 原样透传，未声明 kind 时不做转换', () => {
    expect(coerceValue(undefined, 'string', 'repo')).toEqual({ value: undefined })
    expect(coerceValue(null, 'number', 'maxRetries')).toEqual({ value: undefined })
    expect(coerceValue({ a: 1 }, undefined, 'grayRelease')).toEqual({ value: { a: 1 } })
  })
})

describe('normalizeConfigKeys', () => {
  it('把历史别名写到规范键上，并给出可追溯的告警', () => {
    const result = normalizeConfigKeys({
      repo: 'https://example.com/up.git',
      branch: 'dev',
      targetBranch: 'company',
      dirs: 'src/a,src/b',
      maxParallelFiles: '5',
      previewMode: 'true',
    })

    expect(result.errors).toEqual([])
    expect(result.value.upstreamRepo).toBe('https://example.com/up.git')
    expect(result.value.upstreamBranch).toBe('dev')
    expect(result.value.companyBranch).toBe('company')
    expect(result.value.syncDirs).toEqual(['src/a', 'src/b'])
    expect(result.value.concurrencyLimit).toBe(5)
    expect(result.value.previewOnly).toBe(true)
    expect(result.warnings.some(item => item.includes('别名'))).toBe(true)
  })

  it('扁平别名可以写进嵌套对象（retryConfig.*）', () => {
    const { value } = normalizeConfigKeys({
      maxRetries: 5,
      initialRetryDelay: 100,
      retryDelayFactor: 2,
    })

    expect(value.retryConfig).toEqual({ maxRetries: 5, initialDelay: 100, backoffFactor: 2 })
  })

  it('嵌套别名整块搬迁', () => {
    const gray = { enable: true, percentage: 20 }
    const { value } = normalizeConfigKeys({ grayRelease: gray })
    expect(value.grayReleaseConfig).toEqual(gray)
  })

  it('类型错误的别名收集为错误而不是抛裸 Error', () => {
    const result = normalizeConfigKeys({ maxParallelFiles: 'many', push: 'perhaps' })
    expect(result.errors).toHaveLength(2)
    expect(result.errors[0]).toContain('maxParallelFiles')
    expect(result.value.concurrencyLimit).toBeUndefined()
  })

  it('已废弃的键给出明确说明，而不是静默丢弃', () => {
    const result = normalizeConfigKeys({ cache: { enable: true }, adaptiveConcurrency: true })
    expect(result.warnings.filter(item => item.includes('已废弃'))).toHaveLength(2)
    expect(result.value).toEqual({})
  })

  it('规范键原样保留，未知键留给 unknownKeys 报告', () => {
    const result = normalizeConfigKeys({ upstreamRepo: 'git@host:org/repo.git', typoKey: 1 })
    expect(result.value.upstreamRepo).toBe('git@host:org/repo.git')
    expect(result.value.typoKey).toBe(1)
  })
})

describe('isKnownKey / unknownKeys', () => {
  it('默认配置里的每个键都是已知键', () => {
    for (const key of CANONICAL_KEYS)
      expect(isKnownKey(key)).toBe(true)
    expect(CANONICAL_KEYS.has('upstreamRepo')).toBe(true)
  })

  it('别名同样算已知键', () => {
    for (const key of Object.keys(CONFIG_ALIASES))
      expect(isKnownKey(key)).toBe(true)
  })

  it('只报告真正拼错的键', () => {
    const raw = { upstreamRepo: 'x', syncDirs: ['a'], suncDirs: ['b'], grayRelease: {} } as RawSyncConfig
    expect(unknownKeys(raw)).toEqual(['suncDirs'])
  })
})
