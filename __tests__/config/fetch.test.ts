import type { SyncConfig } from '../../src/domain'
import { cliLayer, parseArgs, unknownFlags } from '../../src/cli'
import { mergeConfigLayers } from '../../src/config/merge'
import { resolveConfig } from '../../src/config/resolve'
import { DEFAULT_FETCH_CONFIG, filterArg } from '../../src/domain'

const BASE = {
  upstreamRepo: 'https://git.example.com/org/upstream.git',
  upstreamBranch: 'main',
  companyBranch: 'company',
  syncDirs: ['src/config'],
  nonInteractive: true,
}

function resolve(extra: Record<string, unknown> = {}) {
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

function flags(argv: string[]): Record<string, unknown> {
  return cliLayer(parseArgs(argv))
}

describe('抓取配置的默认值', () => {
  it('不写就是 0.2 之前的行为：完整抓取、不带标签、LFS 只保留指针', () => {
    const { config } = resolve()

    expect(config.fetchConfig).toEqual(DEFAULT_FETCH_CONFIG)
    expect(config.fetchConfig).toEqual({ filter: 'none', tags: false, lfs: 'pointer' })
    // 深度是"写了才算"的选项：默认不存在，而不是 0
    expect(config.fetchConfig.depth).toBeUndefined()
  })

  it('filterArg 只把 git 认得的写法交出去', () => {
    expect(filterArg('none')).toBeNull()
    expect(filterArg('blob')).toBe('blob:none')
    expect(filterArg('tree')).toBe('tree:0')
  })

  it('每个字段可以只写一半，其余继承默认', () => {
    expect(resolve({ fetchConfig: { filter: 'blob' } }).config.fetchConfig).toEqual({ ...DEFAULT_FETCH_CONFIG, filter: 'blob' })
    expect(resolve({ fetchConfig: { lfs: 'off' } }).config.fetchConfig).toEqual({ ...DEFAULT_FETCH_CONFIG, lfs: 'off' })
  })
})

describe('抓取配置的别名', () => {
  it('partialClone / cloneFilter 都落到 filter', () => {
    expect(resolve({ partialClone: 'blob' }).config.fetchConfig.filter).toBe('blob')
    expect(resolve({ cloneFilter: 'tree' }).config.fetchConfig.filter).toBe('tree')
  })

  it('fetchDepth / fetchTags / lfsMode 各归各位', () => {
    expect(resolve({ fetchDepth: 1 }).config.fetchConfig.depth).toBe(1)
    expect(resolve({ fetchTags: true }).config.fetchConfig.tags).toBe(true)
    expect(resolve({ lfsMode: 'materialize' }).config.fetchConfig.lfs).toBe('materialize')
    expect(resolve({ lfs: 'off' }).config.fetchConfig.lfs).toBe('off')
  })

  it('fetch / clone 是整个 fetchConfig 的别名', () => {
    expect(resolve({ fetch: { filter: 'blob', lfs: 'off' } }).config.fetchConfig).toEqual({ ...DEFAULT_FETCH_CONFIG, filter: 'blob', lfs: 'off' })
  })
})

describe('抓取配置的校验', () => {
  it('非法的 filter 把三个可选值和它们的含义说全', () => {
    const message = rejection({ fetchConfig: { filter: 'blobless' } })

    expect(message).toContain('fetchConfig.filter 无效')
    expect(message).toContain('none（完整抓取）')
    expect(message).toContain('blob（不要文件内容）')
    expect(message).toContain('tree（连目录树也不要）')
  })

  it('depth 只接受正整数', () => {
    expect(resolve({ fetchConfig: { depth: 1 } }).config.fetchConfig.depth).toBe(1)
    expect(rejection({ fetchConfig: { depth: 0 } })).toContain('fetchConfig.depth 必须是大于 0 的整数')
    expect(rejection({ fetchConfig: { depth: -1 } })).toContain('fetchConfig.depth')
    expect(rejection({ fetchConfig: { depth: 1.5 } })).toContain('fetchConfig.depth')
    expect(rejection({ fetchConfig: { depth: 'many' } })).toContain('fetchConfig.depth')
  })

  it('lfs 只认 pointer / materialize / off', () => {
    expect(rejection({ fetchConfig: { lfs: 'smudge' } })).toContain('fetchConfig.lfs 无效')
    expect(rejection({ fetchConfig: { lfs: 'smudge' } })).toContain('materialize（用 git-lfs 取回真实内容）')
    expect(rejection({ fetchConfig: { tags: 'yes' } })).toContain('fetchConfig.tags 必须是布尔值')
  })
})

describe('抓取配置与改名识别互不打脸', () => {
  it('设了 depth 就关掉改名，并说明原因', () => {
    const { config, warnings } = resolve({ fetchConfig: { depth: 50 } })

    expect(config.renameDetection).toBe(false)
    expect(warnings.join('\n')).toContain('fetchConfig.depth 已设置')
    expect(warnings.join('\n')).toContain('关闭重命名识别')
  })

  it('没设 depth 时改名识别不受影响', () => {
    const { config, warnings } = resolve({ fetchConfig: { filter: 'blob' } })

    expect(config.renameDetection).toBe(true)
    expect(warnings.join('\n')).not.toContain('关闭重命名识别')
  })

  it('tree 过滤与 materialize 各自提醒一次代价', () => {
    expect(resolve({ fetchConfig: { filter: 'tree' } }).warnings.join('\n'))
      .toContain('生成计划要逐个回源取对象')
    expect(resolve({ fetchConfig: { filter: 'blob', lfs: 'materialize' } }).warnings.join('\n'))
      .toContain('与部分抓取同时开启时省不下多少流量')
    // pointer 是默认，不该跟着一起啰嗦
    expect(resolve({ fetchConfig: { filter: 'blob' } }).warnings.join('\n'))
      .not
      .toContain('省不下多少流量')
  })

  it('改名被显式关闭时不再重复警告', () => {
    const { warnings } = resolve({ fetchConfig: { depth: 10 }, renameDetection: false })

    expect(warnings.join('\n')).not.toContain('关闭重命名识别')
  })
})

describe('抓取选项的命令行入口', () => {
  it('四个开关各自成一层，不给就不写', () => {
    expect(flags([]).fetchConfig).toBeUndefined()
    expect(flags(['--fetch-filter', 'blob']).fetchConfig).toEqual({ filter: 'blob' })
    expect(flags(['--fetch-depth', '1']).fetchConfig).toEqual({ depth: 1 })
    expect(flags(['--lfs', 'materialize']).fetchConfig).toEqual({ lfs: 'materialize' })
    expect(flags(['--fetch-tags']).fetchConfig).toEqual({ tags: true })
    expect(flags(['--no-fetch-tags']).fetchConfig).toEqual({ tags: false })
  })

  it('开关可以叠加，不会因为一个选项把其它字段重置', () => {
    expect(flags(['--fetch-filter', 'blob', '--fetch-depth', '200', '--lfs', 'off']).fetchConfig)
      .toEqual({ filter: 'blob', depth: 200, lfs: 'off' })
  })

  it('命令行只覆盖写到的字段，配置文件的其余抓取设置保留', () => {
    const fromFile = resolve({ fetchConfig: { filter: 'blob', lfs: 'materialize' } }).config
    const cli = cliLayer(parseArgs(['--lfs', 'off']))

    expect(mergeConfigLayers<SyncConfig>(fromFile, cli).fetchConfig)
      .toEqual({ ...DEFAULT_FETCH_CONFIG, filter: 'blob', lfs: 'off' })
  })

  it('抓取开关不是未知参数', () => {
    expect(unknownFlags(parseArgs(['--fetch-filter', 'blob', '--fetch-depth', '1', '--fetch-tags', '--lfs', 'off']))).toEqual([])
    expect(unknownFlags(parseArgs(['--no-fetch-tags']))).toEqual([])
    expect(unknownFlags(parseArgs(['--fetch-fIlter', 'blob']))).toEqual(['fetch-fIlter'])
  })

  it('--fetch-depth 的非数字值在解析阶段就报错', () => {
    expect(flags(['--fetch-depth', 'abc']).fetchConfig).toEqual({ depth: Number.NaN })
    expect(() => resolveConfig({ ...BASE, ...flags(['--fetch-depth', 'abc']) })).toThrow(/fetchConfig\.depth/)
  })
})
