import type { SyncConfig } from '../../src/domain'
import { resolveConfig } from '../../src/config/resolve'
import { isFanIn, repoDisplayName, sourcesOf, stateFileFor, SYNC_STATE_FILE } from '../../src/pipeline/sources'

const BASE = {
  upstreamRepo: 'https://git.example.com/org/upstream.git',
  upstreamBranch: 'main',
  companyBranch: 'company',
  syncDirs: ['src/config'],
  nonInteractive: true,
}

function configOf(overrides: Record<string, unknown>): SyncConfig {
  return resolveConfig({ ...BASE, ...overrides }).config
}

describe('repoDisplayName', () => {
  it('只取仓库名，尾斜杠与 .git 都不影响结果', () => {
    expect(repoDisplayName('https://git.example.com/org/upstream.git')).toBe('upstream')
    expect(repoDisplayName('https://git.example.com/org/upstream/')).toBe('upstream')
    expect(repoDisplayName('git@git.example.com:org/upstream.git')).toBe('upstream')
    expect(repoDisplayName('C:\\repos\\upstream')).toBe('upstream')
    expect(repoDisplayName('upstream')).toBe('upstream')
    expect(repoDisplayName('   ')).toBe('')
  })
})

describe('stateFileFor', () => {
  it('单上游沿用 .sync-state.json，历史用户的路径不变', () => {
    expect(stateFileFor('https://example.com/a.git', 'main', false)).toBe(SYNC_STATE_FILE)
    expect(stateFileFor('https://example.com/a.git', 'refs/tags/v1.0.0', false)).toBe(SYNC_STATE_FILE)
  })

  it('fan-in 时每个源一个文件，名字带 ref 与仓库指纹', () => {
    const first = stateFileFor('https://example.com/a.git', 'main', true)
    const second = stateFileFor('https://example.com/b.git', 'main', true)
    const tagged = stateFileFor('https://example.com/a.git', 'refs/tags/v1.8.0', true)

    expect(first).not.toBe(SYNC_STATE_FILE)
    expect(first).toMatch(/^\.sync-state-main-[0-9a-f]{8}\.json$/)
    // 同名分支不同仓库必须分开，否则两个上游会互相把对方的成果当成"已同步"。
    expect(second).not.toBe(first)
    expect(tagged).toContain('v1.8.0')
  })

  it('ref 里的非法字符被替换，太长时截断', () => {
    const weird = stateFileFor('https://example.com/a.git', `refs/heads/feature/中文/${'x'.repeat(80)}`, true)
    expect(weird).toMatch(/^\.sync-state-[\w.-]+-[0-9a-f]{8}\.json$/)
    expect(weird).not.toContain('中文')
    expect(weird.length).toBeLessThan(80)
  })
})

describe('sourcesOf：单个上游', () => {
  it('不写 upstreams 时结果就是顶层那一个源，名字全部沿用旧版', () => {
    const [source] = sourcesOf(configOf({}))

    expect(source).toMatchObject({
      index: 0,
      repo: BASE.upstreamRepo,
      ref: 'main',
      remote: 'sync-upstream',
      stateFile: '.sync-state.json',
      label: 'upstream@main',
      dirs: ['src/config'],
    })
    expect(source.source.kind).toBe('branch')
    expect(isFanIn(configOf({}))).toBe(false)
  })

  it('标签与提交号也能当源，标签名不带 refs/tags 前缀', () => {
    const tag = sourcesOf(configOf({ upstreamBranch: 'refs/tags/v1.8.0' }))[0]
    const revision = sourcesOf(configOf({ upstreamBranch: 'deadbeefcafebabe0123456789abcdef01234567' }))[0]

    expect([tag.source.kind, tag.ref]).toEqual(['tag', 'refs/tags/v1.8.0'])
    // 提交号太长，日志与标签里只显示前 8 位。
    expect(revision.label).toBe('upstream@deadbeef')
  })

  it('每个源可以指定自己的目录与提交信息，缺省项继承顶层', () => {
    const [source] = sourcesOf(configOf({
      commitMessage: 'chore: 顶层默认信息',
      upstreams: [{ repo: BASE.upstreamRepo, branch: 'dev', dirs: ['src/ui/'], message: '  自定义信息  ' }],
    }))

    expect(source.dirs).toEqual(['src/ui'])
    expect(source.commitMessage).toBe('自定义信息')
  })

  it('dirs 留空时退回顶层 syncDirs，message 留空时退回顶层 commitMessage', () => {
    const [source] = sourcesOf(configOf({ commitMessage: 'chore: sync from upstream', upstreams: [{ branch: 'dev' }] }))

    expect(source.dirs).toEqual(['src/config'])
    expect(source.commitMessage).toBe('chore: sync from upstream')
  })
})

describe('sourcesOf：多上游 fan-in', () => {
  const fanIn = configOf({
    syncDirs: ['src/config'],
    upstreams: [
      { branch: 'main' },
      { repo: 'https://git.example.com/org/ui-kit.git', branch: 'refs/tags/v1.8.0', dirs: ['src/ui'] },
      { repo: 'git@git.example.com:org/icons.git', branch: 'release/2024' },
    ],
  })

  it('条目按配置顺序展开，顶层字段只当继承来的默认值', () => {
    const sources = sourcesOf(fanIn)

    expect(sources.map(item => item.label)).toEqual(['upstream@main', 'ui-kit@v1.8.0', 'icons@release/2024'])
    expect(sources.map(item => item.index)).toEqual([0, 1, 2])
    expect(sources[1].dirs).toEqual(['src/ui'])
    expect(sources[2].dirs).toEqual(['src/config'])
    expect(isFanIn(fanIn)).toBe(true)
  })

  it('remote 按仓库分配：同仓库的多个分支共用一个，第二个仓库改名', () => {
    const sources = sourcesOf(configOf({
      upstreams: [
        { branch: 'main' },
        { branch: 'dev' },
        { repo: 'https://git.example.com/org/ui-kit.git', branch: 'main' },
        { repo: 'https://git.example.com/org/icons.git', branch: 'main' },
      ],
    }))

    expect(sources.map(item => item.remote)).toEqual([
      'sync-upstream',
      'sync-upstream',
      'sync-upstream-2',
      'sync-upstream-3',
    ])
  })

  it('同一仓库的多个分支共用一个 remote，但各有状态文件', () => {
    const sources = sourcesOf(configOf({
      upstreams: [{ repo: 'https://example.com/a.git', branch: 'main' }, { repo: 'https://example.com/a.git', branch: 'dev' }],
    }))

    expect(sources.map(item => item.remote)).toEqual(['sync-upstream', 'sync-upstream'])
    expect(new Set(sources.map(item => item.stateFile)).size).toBe(2)
    expect(sources.every(item => item.stateFile !== SYNC_STATE_FILE)).toBe(true)
  })

  it('状态文件名同时取决于仓库地址与 ref，改一处就会换一个文件', () => {
    expect(stateFileFor('https://example.com/a.git', 'main', true)).not.toBe(stateFileFor('https://example.com/b.git', 'main', true))
    expect(stateFileFor('https://example.com/a.git', 'main', true)).not.toBe(stateFileFor('https://example.com/a.git', 'dev', true))
  })
})
