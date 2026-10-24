import type { SyncConfig } from '../../src/domain'
import type { SyncRunResult } from '../../src/pipeline/orchestrator'
import type { Fixture } from '../helpers/repo'
import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { resolveConfig } from '../../src/config/resolve'
import { ChangeKind } from '../../src/domain'
import { lfsAvailable } from '../../src/git/lfs'
import { SyncOrchestrator } from '../../src/pipeline/orchestrator'
import { formatLfsFacts } from '../../src/pipeline/preview'
import { fetchSource, parseSourceRef, UPSTREAM_REMOTE } from '../../src/pipeline/upstream-ref'
import { createFixture } from '../helpers/repo'

const HEX = '0123456789abcdef'.repeat(4)
const POINTER = `version https://git-lfs.github.com/spec/v1\noid sha256:${HEX}\nsize 2048\n`

interface LfsFixture {
  up: Fixture
  down: Fixture
  config: (overrides?: Record<string, unknown>) => SyncConfig
  cleanup: () => Promise<void>
}

async function createLfsFixture(): Promise<LfsFixture> {
  const up = await createFixture('main')
  await up.write('src/config/a.ts', 'a base\n')
  await up.write('.gitattributes', '*.png filter=lfs diff=lfs merge=lfs -text\n')
  await up.commitAll('base')

  // 下游从"上游还没动"的那一刻分叉：`.gitattributes` 是跟着一起过来的，
  // 所以本机装了 git-lfs 时，工作区过滤器在这里是开着的 —— 正是同步必须扛住的东西。
  const down = await createFixture('seed')
  await down.git.ensureRemote('origin', up.root)
  await down.git.fetch('origin', 'main')
  down.gitRaw(['checkout', '-q', '--no-track', '-b', 'company', 'FETCH_HEAD'])

  // 上游把图片交给 LFS 管：落到 git 里的就是那段指针文本。
  await up.write('src/config/a.ts', 'a upstream\n')
  await up.write('src/config/logo.png', POINTER)
  await up.write('src/config/plain.ts', 'plain upstream\n')
  await up.commitAll('upstream adds an lfs asset')

  const config = (overrides: Record<string, unknown> = {}): SyncConfig => resolveConfig({
    upstreamRepo: up.root,
    upstreamBranch: 'main',
    companyBranch: 'company',
    syncDirs: ['src/config'],
    nonInteractive: true,
    ...overrides,
  }).config

  return { up, down, config, cleanup: () => Promise.all([up.cleanup(), down.cleanup()]).then(() => undefined) }
}

function run(cfg: SyncConfig, cwd: string): Promise<SyncRunResult> {
  return new SyncOrchestrator({ config: cfg, cwd }).run()
}

let fixture: LfsFixture

beforeEach(async () => {
  fixture = await createLfsFixture()
})

afterEach(async () => {
  await fixture?.cleanup()
})

describe('Git LFS 感知的同步', () => {
  it('默认策略：指针文本原样落地，并说清哪些文件是指针', async () => {
    const result = await run(fixture.config(), fixture.down.root)

    expect(result.commit?.created).toBe(true)
    expect(await fixture.down.read('src/config/logo.png')).toBe(POINTER)
    expect(await fixture.down.read('src/config/a.ts')).toBe('a upstream\n')

    expect(result.lfs?.mode).toBe('pointer')
    expect(result.lfs?.pointers).toEqual(['src/config/logo.png'])
    expect(result.lfs?.materialized).toEqual([])
    expect(result.lfs?.note).toBeUndefined()
    // 每个源各报一份，运行级结果就是它们的合并。
    expect(result.sources[0].lfs?.pointers).toEqual(['src/config/logo.png'])
  })

  it('off 策略不看 LFS，也不报任何事实', async () => {
    const result = await run(fixture.config({ fetchConfig: { lfs: 'off' } }), fixture.down.root)

    expect(result.lfs).toBeUndefined()
    // off 只是不去检测，内容照旧同步。
    expect(await fixture.down.read('src/config/logo.png')).toBe(POINTER)
  })

  it('预览阶段就报出指针，且不动工作区', async () => {
    const before = fixture.down.gitRaw(['rev-parse', 'HEAD'])
    const result = await run(fixture.config({ previewOnly: true }), fixture.down.root)

    expect(result.previewed).toBe(true)
    expect(result.lfs?.pointers).toEqual(['src/config/logo.png'])
    expect(await fixture.down.exists('src/config/logo.png')).toBe(false)
    expect(fixture.down.gitRaw(['rev-parse', 'HEAD'])).toBe(before)
  })

  it('materialize 取不到对象时只记录原因，同步照样完成', async () => {
    const result = await run(fixture.config({ fetchConfig: { lfs: 'materialize' } }), fixture.down.root)

    expect(result.commit?.created).toBe(true)
    expect(result.lfs?.mode).toBe('materialize')
    expect(result.lfs?.pointers).toEqual(['src/config/logo.png'])

    // 本地路径远程没有 LFS 服务：要么整批取回（不可能出现在这台机器上），要么带一句原因。
    if (result.lfs!.materialized.length === 0) {
      expect(result.lfs!.note).toBeTruthy()
      expect(await fixture.down.read('src/config/logo.png')).toBe(POINTER)
    }
    else {
      expect(result.lfs!.materialized).toEqual(['src/config/logo.png'])
      expect(await fixture.down.read('src/config/logo.png')).not.toBe(POINTER)
    }
  })

  it('给操作的措辞：指针模式说清策略，取回失败时把原因顶上', () => {
    const pointerLines = formatLfsFacts({ mode: 'pointer', pointers: ['src/config/logo.png'], materialized: [] }).join('\n')
    expect(pointerLines).toContain('当前策略「保留指针文本」')
    expect(pointerLines).toContain('src/config/logo.png')
    expect(pointerLines).toContain('fetchConfig.lfs = "materialize"')

    const failed = formatLfsFacts({ mode: 'materialize', pointers: ['src/config/logo.png'], materialized: [], note: '本机没有安装 git-lfs' }).join('\n')
    expect(failed).toContain('取回失败：本机没有安装 git-lfs')
    // 已经选了 materialize，就不该再劝人设置 materialize
    expect(failed).not.toContain('需要真实内容')

    const done = formatLfsFacts({ mode: 'materialize', pointers: ['a.png', 'b.png'], materialized: ['a.png', 'b.png'] }).join('\n')
    expect(done).toContain('已取回 2 个 Git LFS 文件的真实内容')
  })

  it('超过 10 个指针时只列前 10 个并说明还有多少', () => {
    const paths = Array.from({ length: 13 }, (_, index) => `src/config/i${index}.png`)
    const text = formatLfsFacts({ mode: 'pointer', pointers: paths, materialized: [] }).join('\n')

    expect(text).toContain('src/config/i9.png')
    expect(text).not.toContain('i10.png')
    expect(text).toContain('另外 3 个')
  })

  /**
   * 这台机器上装了 git-lfs 时，`.gitattributes` 里的 `filter=lfs` 会让工作区检出真的去要对象。
   * 这条测试钉住工具为什么必须跳过 smudge：同样的路径、同样的引用，原始 git 失败，
   * 工具的 checkout 成功并拿到指针。没装 git-lfs 的机器上过滤器根本不存在，测试自动跳过。
   */
  it('工作区过滤器开着时，跳过 smudge 才是唯一能落地的写法', async () => {
    if (!await lfsAvailable(fixture.down.root))
      return
    expect(await fixture.down.git.configValue('filter.lfs.process')).toBe('git-lfs filter-process')

    // 夹具只配了 origin；`sync-upstream/<remote>` 是编排器在真正跑同步时才建的，
    // 单独调用 fetchSource 得自己把同一个远程摆好，否则 fetch 报的是"远程不存在"。
    await fixture.down.git.ensureRemote(UPSTREAM_REMOTE, fixture.up.root)
    await fetchSource(fixture.down.git, UPSTREAM_REMOTE, parseSourceRef('main'), fixture.up.root)
    const ref = `refs/remotes/${UPSTREAM_REMOTE}/main`

    let rawFailed = false
    try {
      execFileSync('git', ['checkout', ref, '--', 'src/config/logo.png'], {
        cwd: fixture.down.root,
        stdio: 'pipe',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      })
    }
    catch {
      rawFailed = true
    }
    expect(rawFailed).toBe(true)

    // 同一个引用、同一个路径，换成工具的入口就能落地。
    await fixture.down.git.checkoutPathsFromRef(ref, ['src/config/logo.png'])
    expect(await fixture.down.read('src/config/logo.png')).toBe(POINTER)
  })
})

describe('抓取策略与一次真实同步', () => {
  it('blob 过滤下计划、内容、增量状态都不受影响', async () => {
    const result = await run(fixture.config({ fetchConfig: { filter: 'blob' } }), fixture.down.root)

    expect(result.plan.changes.length).toBeGreaterThan(0)
    expect(result.commit?.created).toBe(true)
    expect(await fixture.down.read('src/config/a.ts')).toBe('a upstream\n')
    // 再跑一次：抓取过滤不该让增量状态失忆。
    const again = await run(fixture.config({ fetchConfig: { filter: 'blob' } }), fixture.down.root)
    expect(again.commit?.created).toBe(false)
  })

  it('浅抓取完成后本地确实是浅仓库，改名只能按删除+新增处理', async () => {
    // 先把 plain.ts 同步过来，改名那一对路径才两边都有东西可配。
    await run(fixture.config(), fixture.down.root)
    expect(await fixture.down.read('src/config/plain.ts')).toBe('plain upstream\n')

    await fixture.up.gitRaw(['checkout', '-q', 'main'])
    await fixture.up.gitRaw(['mv', 'src/config/plain.ts', 'src/config/renamed.ts'])
    await fixture.up.commitAll('upstream rename')

    const cfg = fixture.config({ fetchConfig: { depth: 1 } })
    expect(cfg.renameDetection).toBe(false)

    const result = await run(cfg, fixture.down.root)

    expect(result.commit?.created).toBe(true)
    expect(await fixture.down.exists('src/config/plain.ts')).toBe(false)
    expect(await fixture.down.read('src/config/renamed.ts')).toBe('plain upstream\n')
    expect(await fixture.down.git.isShallow()).toBe(true)

    const kinds = result.plan.changes.map(item => item.kind)
    expect(kinds).not.toContain(ChangeKind.RENAME)
    expect(kinds).toContain(ChangeKind.DELETE)
    expect(kinds).toContain(ChangeKind.ADD)
  })

  it('带标签抓取时上游标签进 refs/tags，目标分支不受影响', async () => {
    await fixture.up.gitRaw(['tag', 'v2.0.0'])

    const result = await run(fixture.config({ fetchConfig: { tags: true } }), fixture.down.root)

    expect(result.commit?.created).toBe(true)
    expect(fixture.down.gitRaw(['for-each-ref', 'refs/tags/v2.0.0'])).not.toBe('')
  })
})
