import { resolveConfig } from '../../src/config/resolve'
import { ValidationError } from '../../src/errors'

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

describe('upstreams 配置校验', () => {
  it('不写 upstreams 时字段缺席，老配置不会被凭空塞一个数组', () => {
    const { config } = resolve({})
    expect(config.upstreams).toBeUndefined()
  })

  it('fan-in 时逐条保留 repo / branch / dirs / message，并去掉多余空白', () => {
    const { config } = resolve({
      upstreams: [
        { branch: ' dev ' },
        { repo: ' https://git.example.com/org/ui.git ', branch: 'refs/tags/v1', dirs: [' src/ui/ '], message: 'chore: ui' },
      ],
    })

    expect(config.upstreams?.[0]).toEqual({ branch: 'dev' })
    expect(config.upstreams?.[1]).toEqual({
      repo: 'https://git.example.com/org/ui.git',
      branch: 'refs/tags/v1',
      dirs: ['src/ui'],
      message: 'chore: ui',
    })
  })

  it('顶层 upstreamBranch 在 fan-in 时可以省略，每个条目自己写', () => {
    expect(() => resolve({
      upstreamBranch: undefined,
      upstreams: [{ branch: 'main' }, { branch: 'dev' }],
    })).not.toThrow()
  })

  it('条目省略 repo 时继承顶层，因此顶层仍然必填', () => {
    expect(rejection({ upstreamRepo: '', upstreams: [{ branch: 'dev' }] })).toContain('upstreamRepo 不能为空')
    expect(() => resolve({ upstreams: [{ repo: 'https://example.com/a.git', branch: 'dev' }] })).not.toThrow()
  })

  it('非数组 / 非对象 / 非法 URL / 空 branch / 空 dirs / 非法目录各自报错', () => {
    expect(rejection({ upstreams: 'main' })).toContain('必须是数组')
    expect(rejection({ upstreams: ['main'] })).toContain('upstreams[0] 必须是对象')
    expect(rejection({ upstreams: [{ repo: 'not a url', branch: 'dev' }] })).toContain('upstreams[0].repo 不是可识别的仓库地址')
    expect(rejection({ upstreams: [{ branch: '  ' }] })).toContain('upstreams[0].branch')
    expect(rejection({ upstreams: [{ branch: 42 }] })).toContain('upstreams[0].branch')
    expect(rejection({ upstreams: [{ branch: 'dev', dirs: [] }] })).toContain('dirs 必须是非空数组')
    expect(rejection({ upstreams: [{ branch: 'dev', dirs: ['../outside'] }] })).toContain('不允许包含 ..')
    expect(rejection({ upstreams: [{ branch: 'dev', dirs: [1 as never] }] })).toContain('非字符串项')
    expect(rejection({ upstreams: [{ branch: 'dev', message: 7 as never }] })).toContain('message 必须是字符串')
  })

  it('空条目被忽略，不会当成一个源', () => {
    const { config } = resolve({ upstreams: [undefined, null].filter(Boolean) })
    expect(config.upstreams).toEqual([])
    expect(() => resolve({ upstreams: [null, { branch: 'dev' }] })).not.toThrow()
  })

  it('同一个源列两次会警告，因为第二次只会重复搬运', () => {
    const { warnings } = resolve({
      upstreams: [
        { repo: 'https://example.com/a.git', branch: 'main' },
        { repo: 'https://example.com/a.git', branch: 'main' },
      ],
    })

    expect(warnings.join('\n')).toContain('重复的上游')
    expect(warnings.join('\n')).toContain('https://example.com/a.git@main')
  })

  it('同步目录重叠时警告“后一个覆盖前一个”', () => {
    const { warnings } = resolve({
      upstreams: [
        { repo: 'https://example.com/a.git', branch: 'main', dirs: ['src/config'] },
        { repo: 'https://example.com/b.git', branch: 'dev', dirs: ['src/config/nested'] },
      ],
    })

    const text = warnings.join('\n')
    expect(text).toContain('同步目录重叠')
    expect(text).toContain('src/config/nested（upstreams[0] 与 upstreams[1]）')
  })

  it('目录互不相交时不警告', () => {
    const { warnings } = resolve({
      upstreams: [
        { repo: 'https://example.com/a.git', branch: 'main', dirs: ['src/config'] },
        { repo: 'https://example.com/b.git', branch: 'dev', dirs: ['src/ui'] },
      ],
    })

    expect(warnings.filter(warning => warning.includes('重叠'))).toEqual([])
  })

  it('单上游不做重复/重叠检查，避免历史配置凭空多出警告', () => {
    const { warnings } = resolve({ upstreams: [{ repo: 'https://example.com/a.git', branch: 'main', dirs: ['src/config'] }] })
    expect(warnings.filter(warning => /重复的上游|重叠/.test(warning))).toEqual([])
  })

  it('校验失败仍然是 ValidationError，一次性列出所有问题', () => {
    expect(() => resolve({ upstreams: [{ branch: '' }, { repo: 'bad url' }] })).toThrow(ValidationError)
  })

  it('syncDirs 缺失时的提示说明了 upstreams 的继承关系', () => {
    expect(rejection({ syncDirs: [] })).toContain('upstreams 里没写 dirs 的上游会用它')
  })
})
