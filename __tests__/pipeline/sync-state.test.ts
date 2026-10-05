import type { SyncStateData } from '../../src/pipeline/sync-state'
import os from 'node:os'
import path from 'node:path'
import fs from 'fs-extra'
import { ChangeKind } from '../../src/domain'
import { SYNC_STATE_FILE, SyncState } from '../../src/pipeline/sync-state'

let tmpDir: string
const REPO = 'https://example.com/upstream.git'
const BRANCH = 'main'

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-state-'))
})

afterEach(async () => {
  await fs.remove(tmpDir).catch(() => undefined)
})

function statePath(name = SYNC_STATE_FILE): string {
  return path.join(tmpDir, name)
}

describe('SyncState', () => {
  it('首次使用时写入的自身份必须能被下一次读取复用', async () => {
    const filePath = statePath()
    const fresh = await SyncState.load(filePath, REPO, BRANCH)
    expect(fresh.size).toBe(0)

    fresh.record([
      { entry: { kind: ChangeKind.ADD, path: 'src/a.ts', scope: 'src', upstreamOid: 'aaa' }, status: 'applied' },
      { entry: { kind: ChangeKind.MODIFY, path: 'src/b.ts', scope: 'src', upstreamOid: 'bbb' }, status: 'applied' },
    ])
    await fresh.save()

    const reloaded = await SyncState.load(filePath, REPO, BRANCH)
    expect(reloaded.size).toBe(2)
    expect(reloaded.isSynced('src/a.ts', 'aaa')).toBe(true)
    expect(reloaded.isSynced('src/a.ts', 'changed')).toBe(false)
  })

  it('kept-target 与 failed 都不写入状态，删除则移除记录', async () => {
    const filePath = statePath()
    const state = await SyncState.load(filePath, REPO, BRANCH)
    state.record([
      { entry: { kind: ChangeKind.ADD, path: 'src/kept.ts', scope: 'src', upstreamOid: 'k' }, status: 'kept-target' },
      { entry: { kind: ChangeKind.ADD, path: 'src/failed.ts', scope: 'src', upstreamOid: 'f' }, status: 'failed', error: 'boom' },
      { entry: { kind: ChangeKind.ADD, path: 'src/ok.ts', scope: 'src', upstreamOid: 'o' }, status: 'applied' },
    ])
    state.record([
      { entry: { kind: ChangeKind.DELETE, path: 'src/ok.ts', scope: 'src', targetOid: 'o' }, status: 'applied' },
    ])
    await state.save()

    const persisted = await fs.readJson(filePath) as SyncStateData
    expect(Object.keys(persisted.entries)).toEqual([])
    expect(persisted.version).toBe(1)
  })

  it('没有 upstreamOid 的条目不会被记录（否则永远无法判定已同步）', async () => {
    const state = await SyncState.load(statePath(), REPO, BRANCH)
    state.record([{ entry: { kind: ChangeKind.MODIFY, path: 'src/x.ts', scope: 'src' }, status: 'applied' }])
    expect(state.size).toBe(0)
  })

  it('换仓库、换分支、版本不符时状态作废', async () => {
    const filePath = statePath()
    const state = await SyncState.load(filePath, REPO, BRANCH)
    state.record([{ entry: { kind: ChangeKind.ADD, path: 'src/a.ts', scope: 'src', upstreamOid: 'a' }, status: 'applied' }])
    await state.save()

    expect((await SyncState.load(filePath, 'https://other.git', BRANCH)).size).toBe(0)
    expect((await SyncState.load(filePath, REPO, 'release')).size).toBe(0)

    await fs.writeJson(filePath, { version: 2, upstreamRepo: REPO, upstreamBranch: BRANCH, entries: { 'src/a.ts': { upstreamOid: 'a', syncedAt: '' } } })
    expect((await SyncState.load(filePath, REPO, BRANCH)).size).toBe(0)
  })

  it('损坏的状态文件报可定位错误，而不是当作空状态继续跑', async () => {
    const filePath = statePath('broken.json')
    await fs.writeFile(filePath, '{ oops', 'utf8')
    await expect(SyncState.load(filePath, REPO, BRANCH)).rejects.toThrow(/同步状态文件无法读取/)
  })

  it('forget 批量清除记录（回滚时使用）', async () => {
    const state = await SyncState.load(statePath(), REPO, BRANCH)
    state.record([
      { entry: { kind: ChangeKind.ADD, path: 'src/a.ts', scope: 'src', upstreamOid: 'a' }, status: 'applied' },
      { entry: { kind: ChangeKind.ADD, path: 'src/b.ts', scope: 'src', upstreamOid: 'b' }, status: 'applied' },
    ])
    state.forget(['src/a.ts'])
    expect(state.size).toBe(1)
    expect(state.isSynced('src/b.ts', 'b')).toBe(true)
  })

  it('empty() 也携带仓库身份，写入后可被同参数读取', async () => {
    const filePath = statePath('from-empty.json')
    const state = SyncState.empty(filePath, REPO, BRANCH)
    state.record([{ entry: { kind: ChangeKind.ADD, path: 'src/z.ts', scope: 'src', upstreamOid: 'z' }, status: 'applied' }])
    await state.save()

    expect((await SyncState.load(filePath, REPO, BRANCH)).size).toBe(1)
  })
})
