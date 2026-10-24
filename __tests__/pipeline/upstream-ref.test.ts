import type { GitRepository } from '../../src/git/repository'
import type { Fixture } from '../helpers/repo'
import { DEFAULT_FETCH_CONFIG } from '../../src/domain'
import { GitError } from '../../src/errors'
import {
  describeSource,
  fetchedRefCandidates,
  fetchSource,
  findSourceRef,
  parseSourceRef,
  requireSourceRef,
  resolvedKind,
  sourceRefspec,
  UPSTREAM_REMOTE,
} from '../../src/pipeline/upstream-ref'
import { createFixture } from '../helpers/repo'

describe('parseSourceRef：源可以是分支、标签或提交号', () => {
  it('普通写法按分支处理，这是所有既有配置的语义', () => {
    expect(parseSourceRef('main')).toEqual({ input: 'main', kind: 'branch', name: 'main' })
    expect(parseSourceRef('  release/2024  ')).toEqual({ input: 'release/2024', kind: 'branch', name: 'release/2024' })
    expect(parseSourceRef('refs/heads/dev')).toEqual({ input: 'refs/heads/dev', kind: 'branch', name: 'dev' })
  })

  it('refs/tags/ 前缀是标签，前缀被剥掉', () => {
    expect(parseSourceRef('refs/tags/v1.8.0')).toEqual({ input: 'refs/tags/v1.8.0', kind: 'tag', name: 'v1.8.0' })
  })

  it('纯十六进制且含字母的是提交号；纯数字的名字仍是分支', () => {
    expect(parseSourceRef('deadbeefcafebabe0123456789abcdef01234567').kind).toBe('revision')
    expect(parseSourceRef('c0ffee42').kind).toBe('revision')
    expect(parseSourceRef('20240101').kind).toBe('branch')
    expect(parseSourceRef('abc').kind).toBe('branch')
  })

  it('其它 refs/ 写法（PR、Gerrit）原样保留，按 ref 抓取', () => {
    expect(parseSourceRef('refs/pull/42/head')).toEqual({ input: 'refs/pull/42/head', kind: 'branch', name: 'refs/pull/42/head' })
  })

  it('describeSource 与 fetchedRefCandidates 按类型给出措辞与候选', () => {
    expect(describeSource(parseSourceRef('main'))).toBe('分支 main')
    expect(describeSource(parseSourceRef('refs/tags/v1.8.0'))).toBe('标签 v1.8.0')
    // 提交号在日志里只显示前 8 位，完整 sha 没人读得下去。
    expect(describeSource(parseSourceRef('deadbeefcafebabe0123456789abcdef01234567'))).toBe('提交 deadbeef')

    expect(fetchedRefCandidates('r', parseSourceRef('refs/tags/v1'))).toEqual([
      'refs/remotes/r/tags/v1',
      'FETCH_HEAD',
      'refs/tags/v1',
    ])
    expect(fetchedRefCandidates('r', parseSourceRef('main'))).toEqual([
      'refs/remotes/r/main',
      'r/main',
      'refs/remotes/r/tags/main',
      'FETCH_HEAD',
    ])
    // 提交号不认 FETCH_HEAD：一次不相干的抓取留下的 FETCH_HEAD 不是"这个提交在本地"。
    expect(fetchedRefCandidates('r', parseSourceRef('c0ffee42'))).toEqual([
      'refs/remotes/r/revisions/c0ffee42',
      'c0ffee42',
    ])
  })

  it('sourceRefspec：每一种都写进私有命名空间，并允许强推覆盖', () => {
    expect(sourceRefspec('r', parseSourceRef('main'))).toBe('+refs/heads/main:refs/remotes/r/main')
    expect(sourceRefspec('r', parseSourceRef('refs/tags/v1.8.0'))).toBe('+refs/tags/v1.8.0:refs/remotes/r/tags/v1.8.0')
    expect(sourceRefspec('r', parseSourceRef('c0ffee1'))).toBe('+c0ffee1:refs/remotes/r/revisions/c0ffee1')
    // 已经写全的 ref 原样交给 git，不加命名空间。
    expect(sourceRefspec('r', parseSourceRef('refs/pull/42/head'))).toBe('refs/pull/42/head')
  })
})

describe('fetchSource：真实仓库里的抓取', () => {
  let up: Fixture
  let down: Fixture
  let git: GitRepository

  beforeEach(async () => {
    up = await createFixture('main')
    await up.write('src/config/a.ts', 'base\n')
    await up.commitAll('first')
    await up.write('src/config/a.ts', 'second\n')
    await up.commitAll('second')
    await up.gitRaw(['tag', 'v1.0.0'])
    await up.write('src/config/a.ts', 'third\n')
    await up.commitAll('third')

    down = await createFixture('seed')
    await down.write('README.md', 'downstream\n')
    await down.commitAll('downstream base')
    git = down.git
    await git.ensureRemote(UPSTREAM_REMOTE, up.root)
  })

  afterEach(async () => {
    await Promise.all([up?.cleanup(), down?.cleanup()])
  })

  it('分支：抓到 refs/remotes/<remote>/<branch>', async () => {
    await fetchSource(git, UPSTREAM_REMOTE, parseSourceRef('main'), up.root)

    expect(await findSourceRef(git, UPSTREAM_REMOTE, parseSourceRef('main'))).toBe(`refs/remotes/${UPSTREAM_REMOTE}/main`)
    expect(await requireSourceRef(git, UPSTREAM_REMOTE, parseSourceRef('main'), up.root)).toBe(`refs/remotes/${UPSTREAM_REMOTE}/main`)
  })

  it('分支不存在时说明缺什么；普通写法还会顺带试过同名标签', async () => {
    const error = await fetchSource(git, UPSTREAM_REMOTE, parseSourceRef('nope'), up.root).catch(e => e as Error)

    expect(error?.message).toContain('没有分支或标签 nope')
  })

  it('写成分支的标签名（v1.8.0）自动按标签抓取，并记为标签', async () => {
    const source = parseSourceRef('v1.0.0')
    expect(source.kind).toBe('branch')

    await fetchSource(git, UPSTREAM_REMOTE, source, up.root)

    const ref = await requireSourceRef(git, UPSTREAM_REMOTE, source, up.root)
    expect(ref).toBe(`refs/remotes/${UPSTREAM_REMOTE}/tags/v1.0.0`)
    expect(resolvedKind(source, ref)).toBe('tag')
    expect(down.gitRaw(['for-each-ref', 'refs/tags/v1.0.0'])).toBe('')
  })

  it('refs/ 开头的写法不做标签兜底，错误里也只说分支', async () => {
    const error = await fetchSource(git, UPSTREAM_REMOTE, parseSourceRef('refs/heads/nope'), up.root).catch(e => e as Error)

    expect(error?.message).toContain('没有分支 nope')
  })

  it('显式 refs/tags/ 写法找不到时只说标签', async () => {
    await expect(fetchSource(git, UPSTREAM_REMOTE, parseSourceRef('refs/tags/nope'), up.root))
      .rejects
      .toThrow(/没有标签 nope/)
  })

  it('标签写进私有命名空间，绝不创建或覆盖本地同名标签', async () => {
    // 下游自己有一个同名但内容不同的标签，同步上游标签不能动它。
    await down.gitRaw(['tag', '-f', 'v1.0.0'])
    const mine = down.gitRaw(['rev-parse', 'refs/tags/v1.0.0'])

    await fetchSource(git, UPSTREAM_REMOTE, parseSourceRef('refs/tags/v1.0.0'), up.root)

    expect(await findSourceRef(git, UPSTREAM_REMOTE, parseSourceRef('refs/tags/v1.0.0')))
      .toBe(`refs/remotes/${UPSTREAM_REMOTE}/tags/v1.0.0`)
    expect(down.gitRaw(['rev-parse', 'refs/tags/v1.0.0'])).toBe(mine)
    expect(down.gitRaw(['rev-parse', `refs/remotes/${UPSTREAM_REMOTE}/tags/v1.0.0`]))
      .toBe(up.gitRaw(['rev-parse', 'v1.0.0^{commit}']))
  })

  it('提交号：服务端开启 uploadpack.allowAnySHA1InWant 才能按 sha 抓', async () => {
    // 第二个提交已经被后面的提交遮住，不在广告的 ref 里。
    const hidden = up.gitRaw(['rev-parse', 'main~1'])
    up.gitRaw(['config', 'uploadpack.allowAnySHA1InWant', 'true'])

    await fetchSource(git, UPSTREAM_REMOTE, parseSourceRef(hidden), up.root)

    expect(await findSourceRef(git, UPSTREAM_REMOTE, parseSourceRef(hidden)))
      .toBe(`refs/remotes/${UPSTREAM_REMOTE}/revisions/${hidden}`)
    expect(down.gitRaw(['rev-parse', `refs/remotes/${UPSTREAM_REMOTE}/revisions/${hidden}`])).toBe(hidden)
  })

  it('提交号在本地已存在时不需要服务器配合', async () => {
    await fetchSource(git, UPSTREAM_REMOTE, parseSourceRef('main'), up.root)
    const tip = up.gitRaw(['rev-parse', 'main'])

    // 抓取整个分支时对象已经落地，所以这里既不用联网也不会报错。
    await expect(fetchSource(git, UPSTREAM_REMOTE, parseSourceRef(tip), up.root)).resolves.toBeUndefined()
    expect(await git.objectExists(tip)).toBe(true)
    // 对象在本地就是它的来源，不需要有人替它建一个引用。
    expect(await findSourceRef(git, UPSTREAM_REMOTE, parseSourceRef(tip))).toBe(tip)
  })

  it('服务器不支持且本地没有该对象时，错误说明缺的是 allowAnySHA1InWant', async () => {
    const missing = 'deadbeefcafebabe0123456789abcdef01234567'

    const error = await fetchSource(git, UPSTREAM_REMOTE, parseSourceRef(missing), up.root).catch(e => e as Error)

    expect(error).toBeInstanceOf(GitError)
    expect(error?.message).toContain('不支持按提交抓取')
    expect(error?.message).toContain('uploadpack.allowAnySHA1InWant')
    // 提交号只认自己的命名空间和本地对象，FETCH_HEAD 里别人抓的东西不算它。
    expect(await findSourceRef(git, UPSTREAM_REMOTE, parseSourceRef(missing))).toBeNull()
    await expect(requireSourceRef(git, UPSTREAM_REMOTE, parseSourceRef(missing), up.root))
      .rejects
      .toThrow(/没有可用的提交/)
  })

  it('抓取深度写进"找不到"的错误里，让人知道可能是历史被剪短了', async () => {
    const error = await fetchSource(
      git,
      UPSTREAM_REMOTE,
      parseSourceRef('refs/tags/nope'),
      up.root,
      undefined,
      { ...DEFAULT_FETCH_CONFIG, depth: 5 },
    ).catch(e => e as Error)

    expect(error?.message).toContain('没有标签 nope')
    expect(error?.message).toContain('本次抓取深度为 5 个提交')
    // 没设深度时不该冒出这句
    const plain = await fetchSource(git, UPSTREAM_REMOTE, parseSourceRef('refs/tags/nope'), up.root).catch(e => e as Error)
    expect(plain?.message).not.toContain('抓取深度')
  })
})

describe('fetchSource 的抓取策略', () => {
  let up: Fixture
  let down: Fixture
  let git: GitRepository

  beforeEach(async () => {
    up = await createFixture('main')
    await up.write('src/config/a.ts', 'first\n')
    await up.write('src/config/big.png', 'not an lfs pointer, just bytes\n')
    await up.commitAll('first')
    await up.write('src/config/a.ts', 'second\n')
    await up.commitAll('second')
    await up.gitRaw(['tag', 'v1.0.0'])
    await up.write('src/config/a.ts', 'third\n')
    await up.commitAll('third')

    down = await createFixture('seed')
    await down.write('README.md', 'downstream\n')
    await down.commitAll('downstream base')
    git = down.git
    await git.ensureRemote(UPSTREAM_REMOTE, up.root)
  })

  afterEach(async () => {
    await Promise.all([up?.cleanup(), down?.cleanup()])
  })

  it('blob 过滤：服务器不支持时照常完成，而不是把同步打断', async () => {
    // 本地路径远程会打印"filtering not recognized by server"并回落到完整抓取。
    await fetchSource(git, UPSTREAM_REMOTE, parseSourceRef('main'), up.root, undefined, { ...DEFAULT_FETCH_CONFIG, filter: 'blob' })

    const ref = await requireSourceRef(git, UPSTREAM_REMOTE, parseSourceRef('main'), up.root)
    expect(ref).toBe(`refs/remotes/${UPSTREAM_REMOTE}/main`)
    expect(await git.readBlobText(ref, 'src/config/a.ts')).toBe('third\n')
    // 过滤是"请求"，不是既成事实：抓到了就是完整的仓库，没有变浅。
    expect(await git.isShallow()).toBe(false)
  })

  it('tree 过滤同样不报错，计划要的对象仍能读出来', async () => {
    await fetchSource(git, UPSTREAM_REMOTE, parseSourceRef('main'), up.root, undefined, { ...DEFAULT_FETCH_CONFIG, filter: 'tree' })

    const ref = await requireSourceRef(git, UPSTREAM_REMOTE, parseSourceRef('main'), up.root)
    expect([...(await git.listTree(ref)).keys()].sort()).toEqual(['src/config/a.ts', 'src/config/big.png'])
  })

  it('depth=1 让本地仓库变浅，只留下最近一个提交', async () => {
    expect(await git.isShallow()).toBe(false)

    await fetchSource(git, UPSTREAM_REMOTE, parseSourceRef('main'), up.root, undefined, { ...DEFAULT_FETCH_CONFIG, depth: 1 })

    const ref = await requireSourceRef(git, UPSTREAM_REMOTE, parseSourceRef('main'), up.root)
    expect(await git.isShallow()).toBe(true)
    expect(down.gitRaw(['rev-list', '--count', ref])).toBe('1')
    // 内容还是对的：浅历史只影响"往回看"，不影响最新树。
    expect(await git.readBlobText(ref, 'src/config/a.ts')).toBe('third\n')
  })

  it('加大力度重新抓取会把历史补回来', async () => {
    const fetchWith = (depth: number) => fetchSource(git, UPSTREAM_REMOTE, parseSourceRef('main'), up.root, undefined, { ...DEFAULT_FETCH_CONFIG, depth })

    await fetchWith(1)
    expect(down.gitRaw(['rev-list', '--count', `refs/remotes/${UPSTREAM_REMOTE}/main`])).toBe('1')

    await fetchWith(10)
    expect(down.gitRaw(['rev-list', '--count', `refs/remotes/${UPSTREAM_REMOTE}/main`])).toBe('3')
  })

  it('tags=true 才把上游标签带进本地命名空间', async () => {
    await fetchSource(git, UPSTREAM_REMOTE, parseSourceRef('main'), up.root, undefined, { ...DEFAULT_FETCH_CONFIG, tags: false })
    expect(down.gitRaw(['for-each-ref', 'refs/tags/v1.0.0'])).toBe('')

    await fetchSource(git, UPSTREAM_REMOTE, parseSourceRef('main'), up.root, undefined, { ...DEFAULT_FETCH_CONFIG, tags: true })
    expect(down.gitRaw(['for-each-ref', 'refs/tags/v1.0.0'])).not.toBe('')
    expect(down.gitRaw(['rev-parse', 'refs/tags/v1.0.0'])).toBe(up.gitRaw(['rev-parse', 'v1.0.0']))
  })

  it('readBlobTextSafe 对不存在的路径返回 null，不抛', async () => {
    await fetchSource(git, UPSTREAM_REMOTE, parseSourceRef('main'), up.root)

    const ref = `refs/remotes/${UPSTREAM_REMOTE}/main`
    expect(await git.readBlobTextSafe(ref, 'src/config/a.ts')).toBe('third\n')
    expect(await git.readBlobTextSafe(ref, 'src/config/nope.ts')).toBeNull()
    expect(await git.readBlobTextSafe('refs/remotes/nope/nope', 'src/config/a.ts')).toBeNull()
  })
})
