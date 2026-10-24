import type { LockRecord } from '../../src/pipeline/repo-lock'
import os from 'node:os'
import path from 'node:path'
import fs from 'fs-extra'
import { LockError } from '../../src/errors'
import {
  acquireRepoLock,
  isStale,
  readRepoLock,
  REPO_LOCK_FILE,
  repoLockPath,
  withRepoLock,
} from '../../src/pipeline/repo-lock'

let gitDir: string
/** 恒定"活着"的 pid 判定，避免测试受本机进程表影响。 */
const alive = () => true

async function writeLock(record: Partial<LockRecord>): Promise<void> {
  await fs.outputFile(repoLockPath(gitDir), JSON.stringify({
    pid: 424242,
    token: 'other-token',
    label: 'someone else',
    createdAt: Date.now(),
    ...record,
  }))
}

beforeEach(async () => {
  gitDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-lock-'))
})

afterEach(async () => {
  await fs.remove(gitDir).catch(() => undefined)
})

describe('acquireRepoLock', () => {
  it('锁文件放在 .git 里，不污染工作区', async () => {
    const handle = await acquireRepoLock({ gitDir, label: 'sync' })
    expect(handle.file).toBe(path.join(gitDir, REPO_LOCK_FILE))
    expect(await fs.pathExists(handle.file)).toBe(true)
    await handle.release()
    expect(await fs.pathExists(handle.file)).toBe(false)
  })

  it('占用中立即失败，并给出可读的持有者信息', async () => {
    await writeLock({ pid: 999999, label: 'sync main → company' })
    const error = await acquireRepoLock({ gitDir, isPidAlive: alive }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LockError)
    expect((error as LockError).message).toContain('sync main → company')
    expect((error as LockError).message).toContain('sync-upstream.lock')
    // 失败者不能顺手删掉别人的锁
    expect(await fs.pathExists(repoLockPath(gitDir))).toBe(true)
  })

  it('waitMs 内等到对方释放就继续', async () => {
    await writeLock({ pid: 999999 })
    const started = Date.now()
    const release = setTimeout(async () => {
      await fs.remove(repoLockPath(gitDir)).catch(() => undefined)
    }, 100)
    const handle = await acquireRepoLock({
      gitDir,
      waitMs: 5000,
      pollMs: 20,
      isPidAlive: alive,
    })
    clearTimeout(release)
    expect(Date.now() - started).toBeGreaterThanOrEqual(50)
    expect((await readRepoLock(gitDir))?.pid).toBe(process.pid)
    await handle.release()
  })

  it('超时后放弃等待，而不是无限排队', async () => {
    await writeLock({ pid: 999999 })
    await expect(acquireRepoLock({
      gitDir,
      waitMs: 80,
      pollMs: 20,
      isPidAlive: alive,
    })).rejects.toThrow(/等待 80ms 后放弃/)
  })

  it('崩溃留下的死 pid 锁直接接管', async () => {
    await writeLock({ pid: 999999, createdAt: Date.now() - 1000 })
    const handle = await acquireRepoLock({ gitDir, isPidAlive: () => false })
    expect((await readRepoLock(gitDir))?.token).not.toBe('other-token')
    await handle.release()
  })

  it('release 只删自己的锁：被接管后不会误解放行下一个等待者', async () => {
    const handle = await acquireRepoLock({ gitDir, isPidAlive: alive })
    const mine = (await readRepoLock(gitDir))!.token
    await writeLock({ pid: 888888, token: 'thief' })

    await handle.release()
    const after = await readRepoLock(gitDir)
    expect(after?.token).toBe('thief')
    expect(after?.token).not.toBe(mine)
  })

  it('ensureHeld 在锁被抢走时中止，避免交错提交', async () => {
    const handle = await acquireRepoLock({ gitDir, isPidAlive: alive })
    await expect(handle.ensureHeld()).resolves.toBeUndefined()
    await writeLock({ pid: 888888, token: 'thief' })
    await expect(handle.ensureHeld()).rejects.toBeInstanceOf(LockError)
  })
})

describe('isStale', () => {
  const base: LockRecord = { pid: 123, token: 't', label: 'l', createdAt: 1000 }

  it('pid 已退出的锁立刻算过期，不必等满兜底时长', () => {
    expect(isStale(base, 1500, () => false, 30_000)).toBe(true)
  })

  it('持有者还活着时，未到兜底时长不算过期', () => {
    expect(isStale(base, 1500, () => true, 30_000)).toBe(false)
    expect(isStale(base, 40_000, () => true, 30_000)).toBe(true)
  })

  it('读不出创建时间的锁不去猜', () => {
    expect(isStale({ ...base, createdAt: Number.NaN }, 999_999, () => false, 1)).toBe(false)
  })

  it('内容读不懂的锁（pid 未知）只能等老，防止抢走刚创建的活锁', () => {
    expect(isStale({ pid: -1, token: 'x', label: 'unreadable', createdAt: 1000 }, 1500, () => true, 30_000)).toBe(false)
    expect(isStale({ pid: -1, token: 'x', label: 'unreadable', createdAt: 1000 }, 40_000, () => true, 30_000)).toBe(true)
  })
})

describe('损坏与并发', () => {
  it('半截/空锁文件视为被占用，而不是当作没有锁', async () => {
    await fs.outputFile(repoLockPath(gitDir), '')
    await expect(acquireRepoLock({ gitDir, isPidAlive: alive })).rejects.toBeInstanceOf(LockError)
  })

  it('超过兜底时长的垃圾锁可以被接管', async () => {
    const file = repoLockPath(gitDir)
    await fs.outputFile(file, 'not json at all')
    const old = new Date(Date.now() - 60_000)
    await fs.utimes(file, old, old)

    const handle = await acquireRepoLock({ gitDir, staleAfterMs: 30_000, isPidAlive: alive })
    expect((await readRepoLock(gitDir))?.pid).toBe(process.pid)
    await handle.release()
  })

  it('withRepoLock 在同一进程内串行，webhook 连续投递不会并发跑', async () => {
    const order: string[] = []
    let concurrent = 0
    let peak = 0

    const task = (name: string, ms: number) => withRepoLock({ gitDir, isPidAlive: alive }, async () => {
      concurrent++
      peak = Math.max(peak, concurrent)
      order.push(`start:${name}`)
      await new Promise(resolve => setTimeout(resolve, ms))
      concurrent--
      order.push(`end:${name}`)
    })

    await Promise.all([task('a', 40), task('b', 10), task('c', 10)])

    expect(peak).toBe(1)
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c'])
    expect(await fs.pathExists(repoLockPath(gitDir))).toBe(false)
  })

  it('任务抛错也要释放锁，否则整个仓库永久卡死', async () => {
    await expect(withRepoLock({ gitDir, isPidAlive: alive }, async () => {
      throw new Error('boom')
    })).rejects.toThrow('boom')
    expect(await fs.pathExists(repoLockPath(gitDir))).toBe(false)

    const handle = await acquireRepoLock({ gitDir, isPidAlive: alive })
    await handle.release()
  })

  it('失败的任务不会把后续排队者一起拖死', async () => {
    const failed = withRepoLock({ gitDir, isPidAlive: alive }, async () => {
      throw new Error('boom')
    }).catch(() => undefined)
    await expect(withRepoLock({ gitDir, isPidAlive: alive }, async () => 'ok')).resolves.toBe('ok')
    await failed
  })
})
