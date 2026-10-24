import type { UndoResult } from '../../src/pipeline/undo'
import path from 'node:path'
import fs from 'fs-extra'
import { LockError } from '../../src/errors'
import { GitRepository } from '../../src/git/repository'
import { SyncOrchestrator } from '../../src/pipeline/orchestrator'
import { formatUndoResult } from '../../src/pipeline/preview'
import { acquireRepoLock } from '../../src/pipeline/repo-lock'
import { SYNC_STATE_FILE } from '../../src/pipeline/sync-state'
import { undoLastSync } from '../../src/pipeline/undo'
import { createSyncFixture } from '../helpers/sync-fixture'

let fixture: Awaited<ReturnType<typeof createSyncFixture>>

beforeEach(async () => {
  fixture = await createSyncFixture()
})

afterEach(async () => {
  await fixture.cleanup()
})

const ORIGINAL = {
  'src/config/a.ts': 'line one\nline two\nline three\n',
  'src/config/b.md': '# b\n',
  'src/config/keep.txt': 'keep\n',
}

function readState() {
  return fs.readJson(path.join(fixture.down.root, SYNC_STATE_FILE)) as Promise<Record<string, any>>
}

async function sync() {
  return new SyncOrchestrator({ config: fixture.config(), cwd: fixture.down.root }).run()
}

async function undo() {
  return new SyncOrchestrator({ config: fixture.config(), cwd: fixture.down.root }).undo()
}

async function undoDirect(overrides: Record<string, unknown> = {}): Promise<UndoResult> {
  return undoLastSync({ git: new GitRepository(fixture.down.root), config: fixture.config(overrides), repoRoot: fixture.down.root })
}

describe('--undo 撤销最近一次同步', () => {
  it('同步后撤销：内容回到同步前，历史记录被弹出', async () => {
    await fixture.drift()
    await sync()
    expect(await fixture.down.read('src/config/a.ts')).toBe('line one\nline two\nline three upstream\n')
    const syncCommit = fixture.down.gitRaw(['rev-parse', 'HEAD'])

    const result = await undo()

    expect(result).toMatchObject({ reverted: true, target: syncCommit, branch: 'company', files: 4 })
    expect(result.commit).not.toBe(syncCommit)
    expect(fixture.down.gitRaw(['rev-parse', 'HEAD'])).toBe(result.commit)
    expect(await fixture.down.read('src/config/a.ts')).toBe(ORIGINAL['src/config/a.ts'])
    expect(await fixture.down.exists('src/config/b.md')).toBe(true)
    expect(await fixture.down.exists('src/config/new.ts')).toBe(false)

    const state = await readState()
    expect(state.history).toEqual([])
    expect(state.lastSyncCommit).toBeUndefined()
    for (const repoPath of Object.keys(ORIGINAL))
      expect(state.entries[repoPath]).toBeUndefined()
  })

  it('撤销过的路径下次同步会重新应用，而不是被增量状态吞掉', async () => {
    await fixture.drift()
    await sync()
    await undo()

    const again = await sync()

    expect(again.commit?.created).toBe(true)
    expect(await fixture.down.read('src/config/a.ts')).toBe('line one\nline two\nline three upstream\n')
    expect((await readState()).history).toHaveLength(1)
  })

  it('HEAD 已经不是同步提交时拒绝撤销，并给出手工命令', async () => {
    await fixture.drift()
    await sync()
    const syncCommit = fixture.down.gitRaw(['rev-parse', 'HEAD'])
    await fixture.down.write('docs/mine.md', 'my work\n')
    const mine = await fixture.down.commitAll('my own commit')

    const result = await undo()

    expect(result.reverted).toBe(false)
    expect(result.target).toBe(syncCommit)
    expect(result.reason).toContain('git revert')
    expect(result.reason).toContain(syncCommit.slice(0, 8))
    expect(fixture.down.gitRaw(['rev-parse', 'HEAD'])).toBe(mine)
    expect((await readState()).history).toHaveLength(1)
  })

  it('没有同步记录时只说明情况，不算失败', async () => {
    await fs.writeJson(path.join(fixture.down.root, SYNC_STATE_FILE), {
      version: 2,
      upstreamRepo: fixture.up.root,
      upstreamBranch: 'main',
      companyBranch: 'company',
      entries: { 'src/config/a.ts': { upstreamOid: 'a'.repeat(40), syncedAt: '2026-01-01T00:00:00.000Z' } },
      history: [],
    })

    const result = await undoDirect()

    expect(result.reverted).toBe(false)
    expect(result.files).toBe(0)
    expect(result.reason).toContain('没有可撤销的同步记录')
  })

  it('记录里的分支已经不存在时不动当前分支', async () => {
    await fs.writeJson(path.join(fixture.down.root, SYNC_STATE_FILE), {
      version: 2,
      upstreamRepo: fixture.up.root,
      upstreamBranch: 'main',
      companyBranch: 'company',
      entries: {},
      lastSyncCommit: 'b'.repeat(40),
      history: [{
        commit: 'b'.repeat(40),
        source: 'sync-upstream/main',
        branch: 'deleted-branch',
        syncedAt: '2026-01-01T00:00:00.000Z',
        files: 1,
        paths: ['src/config/a.ts'],
        baseCommit: 'a'.repeat(40),
      }],
    })
    const before = fixture.down.gitRaw(['rev-parse', 'HEAD'])

    const result = await undoDirect()

    expect(result.reverted).toBe(false)
    expect(result.reason).toContain('deleted-branch')
    expect(fixture.down.gitRaw(['rev-parse', 'HEAD'])).toBe(before)
  })

  it('停在别的分支上时，先切回记录里的分支再撤销', async () => {
    await fixture.drift()
    await sync()
    await fixture.down.gitRaw(['checkout', '-q', '-b', 'side'])

    const result = await undo()

    expect(result.reverted).toBe(true)
    expect(fixture.down.gitRaw(['branch', '--show-current'])).toBe('company')
  })

  it('与其它同步共用同一把仓库锁', async () => {
    await fixture.drift()
    await sync()
    const gitDir = await fixture.down.git.gitDirectory()
    const handle = await acquireRepoLock({ gitDir, label: '另一条流水线' })

    try {
      await expect(undo()).rejects.toBeInstanceOf(LockError)
    }
    finally {
      await handle.release()
    }

    expect(await undo()).toMatchObject({ reverted: true })
  })

  it('撤销结果对人类是可读的一行', () => {
    const done = formatUndoResult({ reverted: true, target: 'a'.repeat(40), commit: 'b'.repeat(40), branch: 'company', files: 3 }).join('\n')
    expect(done).toContain('已撤销同步')
    expect(done).toContain('3 个文件')
    expect(done).toContain('bbbbbbbb')

    const refused = formatUndoResult({ reverted: false, files: 0, reason: '没有可撤销的同步记录' }).join('\n')
    expect(refused).toContain('没有可撤销的同步记录')
  })
})
