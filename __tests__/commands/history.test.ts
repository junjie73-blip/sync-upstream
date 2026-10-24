import path from 'node:path'
import fs from 'fs-extra'
import { historyCommand } from '../../src/commands/history'
import { SyncOrchestrator } from '../../src/pipeline/orchestrator'
import { SYNC_STATE_FILE } from '../../src/pipeline/sync-state'
import { createSyncFixture } from '../helpers/sync-fixture'

let fixture: Awaited<ReturnType<typeof createSyncFixture>>

beforeEach(async () => {
  fixture = await createSyncFixture()
})

afterEach(async () => {
  await fixture.cleanup()
})

const stateFile = () => path.join(fixture.down.root, SYNC_STATE_FILE)

async function sync(overrides: Record<string, unknown> = {}): Promise<void> {
  await new SyncOrchestrator({ config: fixture.config(overrides), cwd: fixture.down.root }).run()
}

describe('history 子命令', () => {
  it('还没同步过时给出下一步，而不是报错', async () => {
    const { report, lines } = await historyCommand(fixture.context())

    expect(report.ok).toBe(true)
    expect(report.data.exists).toBe(false)
    expect(report.data.records).toEqual([])
    expect(lines.join('\n')).toContain('状态文件尚未生成')
  })

  it('同步一次后能说出 commit、来源、分支与文件数', async () => {
    await fixture.drift()
    await sync()
    const head = fixture.down.gitRaw(['rev-parse', 'HEAD'])

    const { report, lines } = await historyCommand(fixture.context())

    expect(report.data.exists).toBe(true)
    expect(report.data.records).toHaveLength(1)
    const [record] = report.data.records
    expect(record.commit).toBe(head)
    expect(record.isLastSync).toBe(true)
    expect(record.exists).toBe(true)
    expect(record.branch).toBe('company')
    expect(record.source).toBe('sync-upstream/main')
    expect(record.files).toBe(4)
    expect(record.paths).toEqual(['src/config/a.ts', 'src/config/b.md', 'src/config/keep.txt', 'src/config/new.ts'])
    expect(record.syncedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(lines.join('\n')).toContain('当前 HEAD')
    expect(lines.join('\n')).toContain('git revert')
  })

  it('--limit 只截取显示条数，总数仍然报出来', async () => {
    await fixture.drift()
    await sync()
    await fixture.up.gitRaw(['checkout', '-q', 'main'])
    await fixture.up.write('src/config/second.ts', 'second\n')
    await fixture.up.commitAll('second drift')
    await sync()

    const all = await historyCommand(fixture.context())
    expect(all.report.data.records.map(entry => entry.isLastSync)).toEqual([true, false])
    expect(all.lines.join('\n')).toContain('共 2 条记录')

    const trimmed = await historyCommand(fixture.context({ flags: { fetch: false, limit: 1 } }))
    expect(trimmed.report.data.limit).toBe(1)
    expect(trimmed.report.data.records).toHaveLength(1)
    expect(trimmed.lines.join('\n')).toContain('其余 1 条')
  })

  it('状态文件里的 base commit 指向同步前的位置', async () => {
    await fixture.drift()
    const before = fixture.down.gitRaw(['rev-parse', 'HEAD'])
    await sync()

    const { report } = await historyCommand(fixture.context())
    expect(report.data.records[0]?.baseCommit).toBe(before)
    expect(report.data.records[0]?.commit).not.toBe(before)
  })

  it('记录对应的提交已经不在了要说清楚', async () => {
    await fs.writeJson(stateFile(), {
      version: 2,
      upstreamRepo: fixture.up.root,
      upstreamBranch: 'main',
      companyBranch: 'company',
      entries: {},
      lastSyncCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      history: [{
        commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        source: 'sync-upstream/main',
        branch: 'company',
        syncedAt: '2026-01-01T00:00:00.000Z',
        files: 1,
        paths: ['src/config/a.ts'],
        baseCommit: 'a'.repeat(40),
      }],
    })

    const { report, lines } = await historyCommand(fixture.context())

    expect(report.ok).toBe(true)
    expect(report.data.records[0]?.exists).toBe(false)
    expect(report.data.records[0]?.isLastSync).toBe(true)
    expect(lines.join('\n')).toContain('commit 已不可用')
  })

  it('状态文件损坏时给出可执行的修复说明，退出码 1', async () => {
    await fs.writeFile(stateFile(), '{ not json', 'utf8')

    const { report, lines } = await historyCommand(fixture.context())

    expect(report.ok).toBe(false)
    expect(report.exitCode).toBe(1)
    expect(report.data.error).toBeTruthy()
    expect(lines.join('\n')).toContain('状态文件无法解析')
    expect(lines.join('\n')).toContain('删除该文件')
  })

  it('旧版本状态文件没有 history 时不报错', async () => {
    await fs.writeJson(stateFile(), {
      version: 1,
      upstreamRepo: fixture.up.root,
      upstreamBranch: 'main',
      entries: { 'src/config/a.ts': { upstreamOid: 'a'.repeat(40), syncedAt: '2026-01-01T00:00:00.000Z' } },
    })

    const { report, lines } = await historyCommand(fixture.context())

    expect(report.ok).toBe(true)
    expect(report.data.entries).toBe(1)
    expect(report.data.records).toEqual([])
    expect(lines.join('\n')).toContain('共 0 条记录')
  })

  it('--json 时把路径清单也带上', async () => {
    await fixture.drift()
    await sync()

    const { report } = await historyCommand(fixture.context({ json: true }))
    expect(report.data.records[0]?.paths.length).toBe(4)
  })
})
