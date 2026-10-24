import path from 'node:path'
import fs from 'fs-extra'
import { whyCommand } from '../../src/commands/why'
import { ValidationError } from '../../src/errors'
import { SyncOrchestrator } from '../../src/pipeline/orchestrator'
import { captureState, createSyncFixture } from '../helpers/sync-fixture'

let fixture: Awaited<ReturnType<typeof createSyncFixture>>

beforeEach(async () => {
  fixture = await createSyncFixture()
})

afterEach(async () => {
  await fixture.cleanup()
})

async function why(repoPath: string, overrides: Record<string, unknown> = {}) {
  return whyCommand(fixture.context({
    positional: [repoPath],
    flags: { fetch: true },
    ...overrides,
  }))
}

describe('why 子命令', () => {
  it('上游改过的文件：会同步，并说明对象差异', async () => {
    await fixture.drift()

    const { report, lines } = await why('src/config/a.ts')

    expect(report.data.verdict).toBe('will-sync')
    expect(report.data.change?.kind).toBe('modify')
    expect(report.data.scope).toBe('src/config')
    expect(report.data.reasons.join('\n')).toContain('MODIFY')
    expect(lines.join('\n')).toContain('会同步')
  })

  it('上游删除的文件同样给出 DELETE 动作', async () => {
    await fixture.drift()

    const { report } = await why('src/config/b.md')

    expect(report.data.verdict).toBe('will-sync')
    expect(report.data.change?.kind).toBe('delete')
    expect(report.data.inUpstream).toBe(false)
    expect(report.data.inTarget).toBe(true)
  })

  it('同步目录之外的文件直接判为跳过', async () => {
    await fixture.drift()

    const { report } = await why('src/ui/x.ts')

    expect(report.data.verdict).toBe('skipped')
    expect(report.data.scope).toBeNull()
    expect(report.data.reasons.join('\n')).toContain('不在任何同步目录内')
  })

  it('命中忽略规则时把规则原文和来源一起说出来', async () => {
    await fixture.up.gitRaw(['checkout', '-q', 'main'])
    await fixture.up.write('src/config/debug.tmp', 'noise\n')
    await fixture.up.commitAll('add tmp')

    const { report } = await why('src/config/debug.tmp', { config: fixture.config({ ignorePatterns: ['*.tmp'] }) })

    expect(report.data.verdict).toBe('skipped')
    expect(report.data.ignoreRule?.pattern).toBe('*.tmp')
    expect(report.data.ignoreRule?.source).toBe('config')
    expect(report.data.reasons.join('\n')).toContain('被忽略规则命中')
  })

  it('本地与上游都改过：判定冲突并给出处理策略', async () => {
    await fixture.drift()
    await fixture.down.write('src/config/a.ts', 'line one\nline two\nlocal rewrite\n')

    const { report } = await why('src/config/a.ts', { config: fixture.config({ conflictResolutionConfig: { defaultStrategy: 'use-source' } }) })

    expect(report.data.verdict).toBe('conflict')
    expect(report.data.conflictType).toBeTruthy()
    expect(report.data.action).toBe('use-source')
    expect(report.data.reasons.join('\n')).toContain('冲突类型')
  })

  it('双方一致的文件判为 unchanged', async () => {
    const { report } = await why('src/config/keep.txt')

    expect(report.data.verdict).toBe('unchanged')
    expect(report.data.reasons.join('\n')).toContain('两侧一致')
  })

  it('同步过之后，unchanged 会引用状态文件里的记录', async () => {
    await fixture.drift()
    await new SyncOrchestrator({ config: fixture.config(), cwd: fixture.down.root }).run()

    const { report } = await why('src/config/new.ts')

    expect(report.data.verdict).toBe('unchanged')
    expect(report.data.state?.upstreamOid).toBeTruthy()
    expect(report.data.reasons.join('\n')).toContain('状态文件记录')
  })

  it('两个分支都没有的路径返回退出码 1', async () => {
    const { report, lines } = await why('src/config/nope.ts')

    expect(report.ok).toBe(false)
    expect(report.exitCode).toBe(1)
    expect(report.data.verdict).toBe('unknown-path')
    expect(lines.join('\n')).toContain('上游和目标分支都不存在该路径')
  })

  it('给目录时聚合目录下的对象', async () => {
    await fixture.drift()

    const { report } = await why('src/config')

    expect(report.data.verdict).toBe('will-sync')
    expect(report.data.reasons.join('\n')).toContain('这是个目录')
  })

  it('没有上游快照时先说清依据，再给出结论', async () => {
    await fs.remove(path.join(fixture.down.root, '.git', 'FETCH_HEAD'))

    const { report } = await why('src/config/a.ts', { flags: { fetch: false } })

    expect(report.data.basis.ref).toBeNull()
    expect(report.data.reasons.join('\n')).toContain('本地还没有上游数据')
  })

  it('includeFileTypes 过滤掉的扩展名会被点名', async () => {
    await fixture.drift()

    const { report } = await why('src/config/keep.txt', { config: fixture.config({ includeFileTypes: ['.ts'] }) })

    expect(report.data.reasons.join('\n')).toContain('不在 includeFileTypes')
  })

  it('拒绝没有参数的调用', async () => {
    await expect(whyCommand(fixture.context())).rejects.toBeInstanceOf(ValidationError)
  })

  it('只读：不改 HEAD、索引与工作区', async () => {
    await fixture.drift()
    const before = captureState(fixture.down)

    await why('src/config/a.ts')
    await why('src/config')
    await why('src/ui/x.ts')

    expect(captureState(fixture.down)).toBe(before)
  })
})
