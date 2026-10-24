import type { PlanFacts, StatusReport, StatusSource } from '../../src/commands/types'
import type { ChangeEntry } from '../../src/domain'
import path from 'node:path'
import fs from 'fs-extra'
import { configFacts, renderStatus, shortHash, statusCommand, statusMarkdown } from '../../src/commands/status'
import { resolveConfig } from '../../src/config/resolve'
import { ChangeKind } from '../../src/domain'
import { SYNC_STATE_FILE } from '../../src/pipeline/sync-state'
import { captureState, createSyncFixture } from '../helpers/sync-fixture'

/** No repository needed — `renderStatus`/`configFacts` are pure. */
const sampleConfig = resolveConfig({
  upstreamRepo: 'https://example.com/u.git',
  upstreamBranch: 'main',
  companyBranch: 'company',
  syncDirs: ['src/config'],
  nonInteractive: true,
}).config

const EXPECTED = ['src/config/a.ts', 'src/config/b.md', 'src/config/keep.txt', 'src/config/new.ts']

function planOf(overrides: Partial<PlanFacts> = {}): PlanFacts {
  return {
    summary: { add: 0, modify: 0, delete: 0, rename: 0, conflict: 0, skipped: 0 },
    changes: [],
    conflicts: [],
    skipped: [],
    dirty: [],
    upstreamCommitsAhead: 0,
    targetCommitsAhead: 0,
    ...overrides,
  }
}

function blankState(): StatusSource['state'] {
  return {
    file: '/repo/.sync-state.json',
    exists: false,
    version: null,
    readable: true,
    identityMatches: true,
    identity: { upstreamRepo: '', upstreamBranch: '', companyBranch: '' },
    entries: 0,
    lastSyncedAt: null,
    lastSyncCommit: null,
    history: 0,
  }
}

/** One upstream as `status` reports it; a plain config produces exactly one of these. */
function sourceOf(overrides: Partial<StatusSource> = {}): StatusSource {
  return {
    label: 'u@main',
    repo: 'https://example.com/u.git',
    branch: 'main',
    kind: 'branch',
    remote: 'sync-upstream',
    dirs: ['src/config'],
    ref: 'refs/remotes/sync-upstream/main',
    revision: 'b'.repeat(40),
    lastFetchAt: null,
    state: blankState(),
    plan: null,
    ...overrides,
  }
}

function reportOf(data: { plan?: PlanFacts | null, sources?: StatusSource[] } = {}): StatusReport {
  return {
    repo: { root: '/repo', gitDir: '/repo/.git', currentBranch: 'company', head: 'a'.repeat(40) },
    targetBranch: 'company',
    config: configFacts(sampleConfig, null),
    syncDirs: ['src/config'],
    lock: { file: '/repo/.git/sync-upstream.lock', held: false },
    sources: data.sources ?? [sourceOf({ plan: data.plan ?? null })],
  }
}

describe('status 子命令', () => {
  let fixture: Awaited<ReturnType<typeof createSyncFixture>>

  beforeEach(async () => {
    fixture = await createSyncFixture()
  })

  afterEach(async () => {
    await fixture.cleanup()
  })

  it('--fetch 后给出的计划与真实同步一致，且不碰工作区', async () => {
    await fixture.drift()
    const before = captureState(fixture.down)
    const upstreamHead = fixture.up.gitRaw(['rev-parse', 'HEAD'])

    const { report, lines } = await statusCommand(fixture.context({ flags: { fetch: true } }))

    const data = report.data
    const only = data.sources[0]
    expect(report.command).toBe('status')
    expect(report.ok).toBe(true)
    expect(data.sources).toHaveLength(1)
    expect(only.ref).toBe('refs/remotes/sync-upstream/main')
    expect(only.revision).toBe(upstreamHead)
    expect(only.plan?.changes.map(entry => entry.path).sort()).toEqual(EXPECTED)
    expect(only.plan?.summary).toMatchObject({ add: 1, modify: 2, delete: 1 })
    expect(only.plan?.upstreamCommitsAhead).toBe(1)
    expect(lines.join('\n')).toContain('待同步')

    // 只读：HEAD、索引树、工作区 cleanliness 与上游提交数都不变。
    expect(captureState(fixture.down)).toBe(before)
    expect(fixture.up.gitRaw(['rev-list', '--count', 'main'])).toBe('2')
  })

  it('默认离线：本地已有快照时按计划报告，不联网', async () => {
    const before = captureState(fixture.down)

    const { report } = await statusCommand(fixture.context())

    // 夹具是从 origin/FETCH_HEAD 检出的，快照就是它自己，因此计划为空但仍然可用。
    expect(report.data.sources[0].ref).toBe('FETCH_HEAD')
    expect(report.data.sources[0].plan).not.toBeNull()
    expect(report.data.sources[0].plan?.changes).toEqual([])
    expect(captureState(fixture.down)).toBe(before)
  })

  it('没有上游快照时说明缺什么，而不是抛错', async () => {
    await fs.remove(path.join(fixture.down.root, '.git', 'FETCH_HEAD'))

    const { report, lines } = await statusCommand(fixture.context())

    expect(report.ok).toBe(true)
    expect(report.data.sources[0].plan).toBeNull()
    expect(report.data.sources[0].note).toContain('本地还没有上游数据')
    expect(lines.join('\n')).toContain('--fetch')
  })

  it('目标分支不存在时计划不可用，原因写得分支名', async () => {
    const { report } = await statusCommand(fixture.context({ config: fixture.config({ companyBranch: 'nope' }) }))

    expect(report.data.sources[0].plan).toBeNull()
    expect(report.data.sources[0].note).toContain('nope')
    expect(statusMarkdown(report.data)).toContain('计划不可用')
  })

  it('状态文件身份不匹配时同时给出字段与提醒', async () => {
    await fs.writeJson(path.join(fixture.down.root, SYNC_STATE_FILE), {
      version: 2,
      upstreamRepo: fixture.up.root,
      upstreamBranch: 'main',
      companyBranch: 'other-target',
      entries: { 'src/config/a.ts': { upstreamOid: 'x'.repeat(40), syncedAt: '2026-01-01T00:00:00.000Z' } },
      history: [],
    })

    const { report, lines } = await statusCommand(fixture.context())

    expect(report.data.sources[0].state.exists).toBe(true)
    expect(report.data.sources[0].state.identityMatches).toBe(false)
    expect(report.data.sources[0].state.entries).toBe(1)
    expect(report.warnings.join('\n')).toContain('状态文件属于另一个')
    expect(lines.join('\n')).toContain('身份不匹配')
  })

  it('状态文件损坏时降级成警告，命令本身仍然可用', async () => {
    await fs.writeFile(path.join(fixture.down.root, SYNC_STATE_FILE), '{ not json', 'utf8')

    const { report } = await statusCommand(fixture.context())

    expect(report.data.sources[0].state.readable).toBe(false)
    expect(report.data.sources[0].state.error).toBeTruthy()
    expect(report.warnings.some(warning => warning.includes('无法解析'))).toBe(true)
  })

  it('锁被占用时报告持有者与是否失活', async () => {
    const gitDir = await fixture.down.git.gitDirectory()
    const head = await fixture.down.git.head()
    const { acquireRepoLock } = await import('../../src/pipeline/repo-lock')
    const handle = await acquireRepoLock({ gitDir, label: '另一条流水线' })
    try {
      const { report, lines } = await statusCommand(fixture.context())
      expect(report.data.lock.held).toBe(true)
      expect(report.data.lock.holder?.label).toBe('另一条流水线')
      expect(report.data.lock.holder?.stale).toBe(false)
      expect(lines.join('\n')).toContain('被占用')
    }
    finally {
      await handle.release()
      expect(head).toBe(await fixture.down.git.head())
    }
  })
  it('summary 是给 CI 看的 markdown', async () => {
    await fixture.drift()
    const { report } = await statusCommand(fixture.context({ flags: { fetch: true } }))

    const summary = report.summary ?? ''
    expect(summary).toContain('### sync-upstream status')
    expect(summary).toContain('待同步：新增 1、修改 2、重命名 0、删除 1')
    expect(summary).toContain('`src/config/new.ts`（add）')
  })
})

describe('status 渲染', () => {
  it('默认只列 10 个变更，--verbose 列全', () => {
    const changes: ChangeEntry[] = Array.from({ length: 15 }, (_, index) => ({
      kind: ChangeKind.MODIFY,
      path: `src/config/f${index}.ts`,
      scope: 'src/config',
    }))
    const plan = planOf({ changes, summary: { add: 0, modify: 15, delete: 0, rename: 0, conflict: 0, skipped: 0 } })

    const brief = renderStatus(reportOf({ plan }), false).join('\n')
    const full = renderStatus(reportOf({ plan }), true).join('\n')

    expect(brief).toContain('其余 5 项')
    expect(brief).not.toContain('src/config/f14.ts')
    expect(full).toContain('src/config/f14.ts')
    expect(full).not.toContain('其余')
  })

  it('改名一行写出两个路径，摘要里的重命名计数单列', () => {
    const plan = planOf({
      changes: [{ kind: ChangeKind.RENAME, path: 'src/config/moved.ts', fromPath: 'src/config/plain.ts', scope: 'src/config', similarity: 100 }],
      summary: { add: 0, modify: 0, delete: 0, rename: 1, conflict: 0, skipped: 0 },
    })

    const text = renderStatus(reportOf({ plan }), true).join('\n')
    expect(text).toContain('src/config/plain.ts → src/config/moved.ts')
    // 旧的"- 删除 + 新增"两行写法不该再出现：改名被折叠成了一行。
    expect(text).not.toContain('- src/config/plain.ts')
    expect(statusMarkdown(reportOf({ plan })).replace(/\s+/g, ' '))
      .toContain('待同步：新增 0、修改 0、重命名 1、删除 0、冲突 0、跳过 0')
  })

  it('多上游时每个源各一段，目录与状态文件都跟着自己的上游', () => {
    const text = renderStatus(reportOf({
      sources: [
        sourceOf({ label: 'base@main', dirs: ['src/config'], plan: planOf({ changes: [{ kind: ChangeKind.MODIFY, path: 'src/config/a.ts', scope: 'src/config' }], summary: { add: 0, modify: 1, delete: 0, rename: 0, conflict: 0, skipped: 0 } }) }),
        sourceOf({
          label: 'ui@v1.8.0',
          repo: 'https://example.com/ui.git',
          branch: 'v1.8.0',
          kind: 'tag',
          remote: 'sync-upstream-2',
          dirs: ['src/ui'],
          state: { ...blankState(), file: '/repo/.sync-state-v1.8.0-abc.json', exists: true, entries: 3, history: 2 },
        }),
      ],
    }), false).join('\n')

    expect(text).toContain('上游数量')
    expect(text).toContain('源 1/2 · base@main')
    expect(text).toContain('源 2/2 · ui@v1.8.0')
    expect(text).toContain('（标签）')
    expect(text).toContain('src/ui')
    expect(text).toContain('.sync-state-v1.8.0-abc.json')
    expect(statusMarkdown(reportOf({
      sources: [
        sourceOf({ label: 'base@main' }),
        sourceOf({ label: 'ui@v1.8.0', branch: 'v1.8.0', kind: 'tag', dirs: ['src/ui'] }),
      ],
    })).split('\n').filter(line => line.startsWith('- 上游：'))).toHaveLength(2)
  })

  it('冲突、跳过原因与本地改动各占一行', () => {
    const plan = planOf({
      conflicts: [{ path: 'src/config/a.ts', conflictType: 'both-modified' }],
      skipped: [
        { path: 'src/config/x.tmp', reason: 'ignored' },
        { path: 'src/config/y.tmp', reason: 'ignored' },
        { path: 'src/config/z.vue', reason: 'file-type' },
      ],
      dirty: ['src/config/a.ts'],
      summary: { add: 0, modify: 0, delete: 0, rename: 0, conflict: 1, skipped: 3 },
    })

    const text = renderStatus(reportOf({ plan }), true).join('\n')
    expect(text).toContain('both-modified')
    expect(text).toContain('ignored=2')
    expect(text).toContain('file-type=1')
    expect(text).toContain('1 个同步目录内文件已被本地修改')
  })

  it('configFacts 只带上有意义的开关', () => {
    const plain = configFacts(sampleConfig, '/tmp/sync-upstream.config.json')
    expect(plain.source).toBe('/tmp/sync-upstream.config.json')
    expect(plain.branchStrategy).toBeUndefined()
    expect(plain.webhook).toBeUndefined()

    const busy = configFacts(resolveConfig({
      ...sampleConfig,
      branchStrategyConfig: { enable: true, strategy: 'feature', baseBranch: 'company' },
      grayReleaseConfig: { enable: true, strategy: 'percentage', percentage: 30 },
      webhookConfig: { enable: true, port: 9000, path: '/hooks/sync', secret: 'x', host: '0.0.0.0' },
    }).config, null)
    expect(busy.branchStrategy).toContain('feature')
    expect(busy.grayRelease).toBe('percentage 30%')
    expect(busy.webhook).toBe('0.0.0.0:9000/hooks/sync')
  })

  it('shortHash 对空值给出占位符', () => {
    expect(shortHash('a'.repeat(40))).toBe('aaaaaaaa')
    expect(shortHash(null)).toBe('—')
  })
})
