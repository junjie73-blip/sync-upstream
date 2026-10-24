import type { SyncConfig } from '../../src/domain'
import type { Fixture } from '../helpers/repo'
import path from 'node:path'
import fs from 'fs-extra'
import { doctorCommand } from '../../src/commands/doctor'
import { historyCommand } from '../../src/commands/history'
import { statusCommand } from '../../src/commands/status'
import { whyCommand } from '../../src/commands/why'
import { resolveConfig } from '../../src/config/resolve'
import { SyncOrchestrator } from '../../src/pipeline/orchestrator'
import { repoDisplayName, stateFileFor, SYNC_STATE_FILE } from '../../src/pipeline/sources'
import { createFixture } from '../helpers/repo'

/**
 * 两个上游 fan-in 到同一个目标分支：`base` 用分支，`ui` 用标签。
 * 每个源各自抓取、各自成一条提交、各自记账 —— 这就是 fan-in 的全部承诺。
 */
interface FanInFixture {
  base: Fixture
  ui: Fixture
  down: Fixture
  config: (overrides?: Record<string, unknown>) => SyncConfig
  context: (overrides?: Record<string, unknown>) => Parameters<typeof statusCommand>[0]
  drift: () => Promise<void>
  cleanup: () => Promise<void>
}

async function repoWith(branch: string, files: Record<string, string>): Promise<Fixture> {
  const fixture = await createFixture(branch)
  for (const [repoPath, content] of Object.entries(files))
    await fixture.write(repoPath, content)
  await fixture.commitAll('initial')
  return fixture
}

async function createFanInFixture(): Promise<FanInFixture> {
  const base = await repoWith('main', {
    'src/config/a.ts': 'a base\n',
    'src/config/keep.txt': 'keep\n',
    'docs/out-of-scope.md': '谁都不该动我\n',
  })
  const ui = await repoWith('main', {
    'src/ui/x.ts': 'x v1\n',
    'src/ui/keep.txt': 'ui keep\n',
  })

  // 目标分支从 base 的初始提交切出来，和真实 fork 一样。
  const down = await createFixture('seed')
  await down.write('README.md', 'downstream\n')
  await down.commitAll('downstream base')
  await down.git.ensureRemote('origin', base.root)
  await down.git.fetch('origin', 'main')
  down.gitRaw(['checkout', '-q', '--no-track', '-b', 'company', 'FETCH_HEAD'])
  // src/ui/keep.txt 与 UI 上游一字不差：它不该出现在任何计划里，用来证明同步只动有差异的文件。
  await down.write('src/ui/keep.txt', 'ui keep\n')
  await down.commitAll('seed ui keep')

  const config = (overrides: Record<string, unknown> = {}): SyncConfig => resolveConfig({
    upstreamRepo: base.root,
    upstreamBranch: 'main',
    companyBranch: 'company',
    syncDirs: ['src/config'],
    nonInteractive: true,
    upstreams: [
      { branch: 'main', dirs: ['src/config'], message: 'chore(sync): 基础库' },
      { repo: ui.root, branch: 'refs/tags/v1.8.0', dirs: ['src/ui'], message: 'chore(sync): UI 库' },
    ],
    ...overrides,
  }).config

  const drift = async (): Promise<void> => {
    await base.gitRaw(['checkout', '-q', 'main'])
    await base.write('src/config/a.ts', 'a upstream\n')
    await base.write('src/config/new.ts', 'brand new\n')
    await base.commitAll('base drift')

    await ui.gitRaw(['checkout', '-q', 'main'])
    await ui.write('src/ui/x.ts', 'x from tag\n')
    await ui.write('src/ui/y.ts', 'y from tag\n')
    await ui.commitAll('ui drift')
    await ui.gitRaw(['tag', 'v1.8.0'])
  }

  return {
    base,
    ui,
    down,
    config,
    context: (overrides = {}) => ({
      config: config(),
      configSource: null,
      cwd: down.root,
      json: false,
      positional: [],
      flags: { fetch: false },
      ...overrides,
    }),
    drift,
    cleanup: () => Promise.all([base.cleanup(), ui.cleanup(), down.cleanup()]).then(() => undefined),
  }
}

let fixture: FanInFixture

beforeEach(async () => {
  fixture = await createFanInFixture()
})

afterEach(async () => {
  await fixture?.cleanup()
})

/** 与 `sourcesOf` 同一套命名规则，测试不必复制实现也能拿到文件名。 */
function stateFor(index: number): string {
  const cfg = fixture.config()
  const entry = cfg.upstreams?.[index] ?? {}
  return stateFileFor(entry.repo ?? cfg.upstreamRepo, entry.branch ?? cfg.upstreamBranch, true)
}

async function stateOf(index: number): Promise<Record<string, any>> {
  return fs.readJson(path.join(fixture.down.root, stateFor(index)))
}

async function stateFiles(): Promise<string[]> {
  const entries = await fs.readdir(fixture.down.root)
  return entries.filter(name => name.startsWith('.sync-state')).sort()
}

function subjects(): string[] {
  return fixture.down.gitRaw(['log', '--format=%s', 'company']).split(/\r?\n/).filter(Boolean)
}

/** 倒数第 `count` 条提交各自改了哪些文件， newest first。 */
function touchedBy(count: number): string[][] {
  return Array.from({ length: count }, (_, index) => fixture.down
    .gitRaw(['show', '--name-status', '--format=', `HEAD~${index}`])
    .split(/\r?\n/)
    .filter(Boolean))
}

async function run(overrides: Record<string, unknown> = {}) {
  return new SyncOrchestrator({ config: fixture.config(overrides), cwd: fixture.down.root }).run()
}

const BASE_LABEL = () => `${repoDisplayName(fixture.base.root)}@main`
const UI_LABEL = () => `${repoDisplayName(fixture.ui.root)}@v1.8.0`

describe('多上游 fan-in：一次运行两个源', () => {
  it('每个源一条提交，各自只改自己的目录', async () => {
    await fixture.drift()
    const before = fixture.down.gitRaw(['rev-parse', 'HEAD'])

    const result = await run()

    expect(result.sources.map(item => item.label)).toEqual([BASE_LABEL(), UI_LABEL()])
    expect(result.sources.map(item => item.kind)).toEqual(['branch', 'tag'])
    expect(result.sources.map(item => item.remote)).toEqual(['sync-upstream', 'sync-upstream-2'])
    expect(result.sources.every(item => item.commit?.created)).toBe(true)

    // 提交顺序就是配置顺序：最后一个源的话事权最大，它的提交在 HEAD。
    expect(subjects().slice(0, 2)).toEqual(['chore(sync): UI 库', 'chore(sync): 基础库'])
    const [uiCommit, baseCommit] = touchedBy(2)
    // 下游的 src/ui 里只有 keep.txt，所以 x.ts 与 y.ts 都是新增；keep.txt 一字不差，不进计划。
    expect(uiCommit.sort()).toEqual(['A\tsrc/ui/x.ts', 'A\tsrc/ui/y.ts'])
    expect(baseCommit.sort()).toEqual(['A\tsrc/config/new.ts', 'M\tsrc/config/a.ts'])

    expect(await fixture.down.read('src/config/a.ts')).toBe('a upstream\n')
    expect(await fixture.down.read('src/ui/x.ts')).toBe('x from tag\n')
    // 目录之外的文件谁都不许碰。
    expect(await fixture.down.exists('docs/out-of-scope.md')).toBe(true)
    expect(fixture.down.gitRaw(['rev-parse', 'HEAD~2'])).toBe(before)
  })

  it('状态文件一源一份，身份与增量记录各记各的', async () => {
    await fixture.drift()
    await run()

    const files = await stateFiles()
    expect(files.sort()).toEqual([stateFor(0), stateFor(1)].sort())
    // fan-in 之后不再有裸的 .sync-state.json，否则两个上游会互相把对方的成果当成“已同步”。
    expect(files).not.toContain(SYNC_STATE_FILE)

    const baseState = await stateOf(0)
    const uiState = await stateOf(1)
    expect(baseState.upstreamRepo).toBe(fixture.base.root)
    expect(baseState.upstreamBranch).toBe('main')
    expect(uiState.upstreamRepo).toBe(fixture.ui.root)
    expect(uiState.upstreamBranch).toBe('refs/tags/v1.8.0')
    expect(uiState.companyBranch).toBe('company')
    expect(baseState.history[0].source).toBe('sync-upstream/main')
    expect(uiState.history[0].source).toBe('sync-upstream-2/refs/tags/v1.8.0')

    // 增量记录只包含本源搬运过的文件。
    expect(Object.keys(baseState.entries).sort()).toEqual(['src/config/a.ts', 'src/config/new.ts'])
    expect(Object.keys(uiState.entries).sort()).toEqual(['src/ui/x.ts', 'src/ui/y.ts'])
  })

  it('第二次运行没有变更，也不会留下空提交', async () => {
    await fixture.drift()
    await run()
    const head = fixture.down.gitRaw(['rev-parse', 'HEAD'])
    const commits = subjects().length

    const again = await run()

    expect(again.sources.every(item => item.plan.changes.length === 0)).toBe(true)
    expect(again.sources.every(item => item.commit?.created === false)).toBe(true)
    expect(again.commit?.created).toBe(false)
    expect(fixture.down.gitRaw(['rev-parse', 'HEAD'])).toBe(head)
    expect(subjects()).toHaveLength(commits)
  })

  it('只有一个上游动了时，另一个源的计划保持为空', async () => {
    await fixture.drift()
    await run()

    await fixture.base.gitRaw(['checkout', '-q', 'main'])
    await fixture.base.write('src/config/late.ts', 'late\n')
    await fixture.base.commitAll('base only')

    const result = await run()

    expect(result.sources[0].plan.changes.map(entry => entry.path)).toEqual(['src/config/late.ts'])
    expect(result.sources[1].plan.changes).toEqual([])
    expect(result.sources[0].commit?.created).toBe(true)
    expect(result.sources[1].commit?.created).toBe(false)
  })

  it('预览不落地：两个源的计划都在，但工作区、HEAD 与状态文件都不变', async () => {
    await fixture.drift()
    const before = fixture.down.gitRaw(['rev-parse', 'HEAD'])

    const result = await run({ previewOnly: true })

    expect(result.previewed).toBe(true)
    expect(result.sources.every(item => item.previewed)).toBe(true)
    expect(result.plan.changes).toHaveLength(4)
    expect(fixture.down.gitRaw(['rev-parse', 'HEAD'])).toBe(before)
    expect(await stateFiles()).toEqual([])
    expect(await fixture.down.exists('src/config/new.ts')).toBe(false)
    expect(await fixture.down.exists('src/ui/y.ts')).toBe(false)
  })

  it('标签源固定在上游分支后面：打了新提交也不会跟过来', async () => {
    await fixture.drift()
    await run()

    await fixture.ui.gitRaw(['checkout', '-q', 'main'])
    await fixture.ui.write('src/ui/after-tag.ts', 'after the tag\n')
    await fixture.ui.commitAll('ui after tag')

    const result = await run()

    expect(result.sources[1].plan.changes).toEqual([])
    expect(await fixture.down.exists('src/ui/after-tag.ts')).toBe(false)
  })

  it('目录重叠时，后一个源按自己的树接管该目录', async () => {
    await fixture.drift()

    const result = await run({
      upstreams: [
        { repo: fixture.base.root, branch: 'main', dirs: ['src/config'] },
        { repo: fixture.ui.root, branch: 'refs/tags/v1.8.0', dirs: ['src/config', 'src/ui'] },
      ],
    })

    expect(result.sources.every(item => item.commit?.created)).toBe(true)
    expect(await fixture.down.read('src/ui/x.ts')).toBe('x from tag\n')
    // UI 上游的 src/config 是空的，接管之后基础库的文件会被删掉 —— 这就是配置警告说的事。
    expect(await fixture.down.exists('src/config/a.ts')).toBe(false)
    expect(await fixture.down.exists('src/config/new.ts')).toBe(false)
  })
})

describe('多上游 fan-in：诊断与撤销', () => {
  it('status 一个源一段，目录、快照与状态文件都跟着自己的上游', async () => {
    await fixture.drift()
    await run()

    const { report, lines } = await statusCommand(fixture.context({ flags: { fetch: true } }))

    expect(report.ok).toBe(true)
    expect(report.data.config.upstreams).toBe(2)
    expect(report.data.sources.map(item => item.label)).toEqual([BASE_LABEL(), UI_LABEL()])
    expect(report.data.sources.map(item => item.dirs)).toEqual([['src/config'], ['src/ui']])
    expect(report.data.sources.map(item => path.basename(item.state.file))).toEqual([stateFor(0), stateFor(1)])
    expect(report.data.sources.map(item => item.state.identityMatches)).toEqual([true, true])
    expect(report.data.sources.map(item => item.state.exists)).toEqual([true, true])
    expect(report.data.sources[1].kind).toBe('tag')
    expect(report.data.sources[1].ref).toBe('refs/remotes/sync-upstream-2/tags/v1.8.0')
    expect(lines.join('\n')).toContain('源 2/2')
  })

  it('history 合并两个状态文件，并标出每条记录属于哪个源', async () => {
    await fixture.drift()
    await run()

    const { report, lines } = await historyCommand(fixture.context())

    expect(report.data.files.map(file => file.file)).toEqual([stateFor(0), stateFor(1)])
    expect(report.data.total).toBe(2)
    expect(new Set(report.data.records.map(record => record.source))).toEqual(new Set([
      'sync-upstream/main',
      'sync-upstream-2/refs/tags/v1.8.0',
    ]))
    expect(new Set(report.data.records.map(record => record.label))).toEqual(new Set([BASE_LABEL(), UI_LABEL()]))
    const text = lines.join('\n')
    expect(text).toContain(BASE_LABEL())
    expect(text).toContain(UI_LABEL())
  })

  it('doctor 报告 fan-in 数量，并逐个上游检查快照与状态文件', async () => {
    await fixture.drift()
    await run()

    const { report, lines } = await doctorCommand(fixture.context())

    const upstreams = report.data.checks.find(check => check.id === 'upstreams')
    expect(upstreams?.level).toBe('info')
    expect(upstreams?.message).toContain('2 个上游 fan-in')
    expect(report.data.checks.filter(check => check.id === 'state-file')).toHaveLength(2)
    expect(report.data.checks.filter(check => check.id === 'upstream-snapshot'))
      .toEqual(expect.arrayContaining([expect.objectContaining({ level: 'pass' })]))
    expect(lines.join('\n')).toContain(`${BASE_LABEL()} + ${UI_LABEL()}`)
  })

  it('why 按路径找覆盖它的上游，而不是永远问第一个', async () => {
    await fixture.drift()
    await run()

    const { report } = await whyCommand(fixture.context({ positional: ['src/ui/x.ts'] }))

    expect(report.ok).toBe(true)
    expect(report.data.basis.label).toBe(UI_LABEL())
    expect(report.data.reasons.join('\n')).toContain('两侧一致')
  })

  it('--undo 只回退最近那个源的提交，另一个源的成果保留', async () => {
    await fixture.drift()
    await run()
    const baseCommit = fixture.down.gitRaw(['rev-parse', 'HEAD~1'])

    const result = await new SyncOrchestrator({ config: fixture.config(), cwd: fixture.down.root }).undo()

    expect(result.reverted).toBe(true)
    expect(result.files).toBe(2)
    expect(await fixture.down.exists('src/ui/y.ts')).toBe(false)
    // 这两个文件对下游是新增，撤销自然把它们带走；keep.txt 不属于同步提交，原地不动。
    expect(await fixture.down.exists('src/ui/x.ts')).toBe(false)
    expect(await fixture.down.read('src/ui/keep.txt')).toBe('ui keep\n')
    // 基础库那条提交不是撤销对象；撤销本身又叠了一条 revert 提交，所以它在 HEAD~2。
    expect(fixture.down.gitRaw(['rev-parse', 'HEAD~2'])).toBe(baseCommit)
    expect(await fixture.down.read('src/config/a.ts')).toBe('a upstream\n')

    expect((await stateOf(1)).history).toEqual([])
    expect((await stateOf(0)).history).toHaveLength(1)
    expect((await stateOf(1)).entries['src/ui/y.ts']).toBeUndefined()
    expect((await stateOf(0)).entries['src/config/a.ts']).toBeTruthy()
  })

  it('撤销最近一个源后再同步，只会重新搬运该源的内容', async () => {
    await fixture.drift()
    await run()
    await new SyncOrchestrator({ config: fixture.config(), cwd: fixture.down.root }).undo()

    const again = await run()

    expect(again.sources[0].commit?.created).toBe(false)
    expect(again.sources[1].commit?.created).toBe(true)
    expect(await fixture.down.read('src/ui/x.ts')).toBe('x from tag\n')
  })
})

describe('多上游 fan-in：配置约束', () => {
  it('灰度发布与 fan-in 互斥，错误里说清怎么改', async () => {
    await fixture.drift()

    await expect(run({
      grayReleaseConfig: { enable: true, strategy: 'percentage', percentage: 30 },
    })).rejects.toThrow(/多上游模式（upstreams）暂不支持.*灰度发布/)
    // 拒绝发生在任何写入之前：一条同步提交都不许有（夹具自带的提交另算）。
    expect(subjects().filter(subject => subject.startsWith('chore(sync):'))).toEqual([])
  })

  it('--rollback 同样被拒绝', async () => {
    await expect(run({
      rollback: true,
      grayReleaseConfig: { enable: true, strategy: 'percentage', percentage: 30 },
    })).rejects.toThrow(/灰度回滚/)
  })

  it('去掉 upstreams 数组后回到单上游：remote、文件名与旧版本一致', async () => {
    await fixture.drift()

    const single = await run({ upstreams: undefined })

    expect(single.sources).toHaveLength(1)
    expect(single.sources[0].remote).toBe('sync-upstream')
    expect(single.sources[0].stateFile).toBe(SYNC_STATE_FILE)
    expect(await stateFiles()).toEqual([SYNC_STATE_FILE])
    expect(await fixture.down.read('src/config/a.ts')).toBe('a upstream\n')
  })
})
