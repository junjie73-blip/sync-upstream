import type { SyncConfig } from '../../src/domain'
import type { Fixture } from '../helpers/repo'
import { resolveConfig } from '../../src/config/resolve'
import { ChangeKind, ConflictResolutionStrategy } from '../../src/domain'
import { SyncOrchestrator } from '../../src/pipeline/orchestrator'
import { createFixture } from '../helpers/repo'

/**
 * `deletePolicy` 决定"上游把文件删了"这件事在本地的下场。
 * 默认 mirror 保持历史行为；keep 是"我在这上面有改动，别删"；ask 把决定权交给运行的人，
 * 而在问不出答案的场合（-y、--json、没有终端）必须倒向保留——少删一个文件下次还能补，
 * 删错了就找不回来。
 */
let up: Fixture
let down: Fixture

const LOCAL_ONLY = 'src/config/gone.ts'

beforeEach(async () => {
  up = await createFixture('main')
  await up.write('src/config/a.ts', 'a base\n')
  await up.write(LOCAL_ONLY, 'to be deleted upstream\n')
  await up.write('src/ui/outside.ts', 'outside\n')
  await up.commitAll('upstream base')

  down = await createFixture('seed')
  await down.git.ensureRemote('origin', up.root)
  await down.git.fetch('origin', 'main')
  down.gitRaw(['checkout', '-q', '--no-track', '-b', 'company', 'FETCH_HEAD'])
})

afterEach(async () => {
  await Promise.all([up?.cleanup(), down?.cleanup()])
})

function config(overrides: Record<string, unknown> = {}): SyncConfig {
  return resolveConfig({
    upstreamRepo: up.root,
    upstreamBranch: 'main',
    companyBranch: 'company',
    syncDirs: ['src/config'],
    nonInteractive: true,
    ...overrides,
  }).config
}

/** 上游删掉一个文件，同时改一个无关文件，用来确认删除策略不影响其他同步。 */
async function upstreamDeletesAFile(): Promise<void> {
  await up.gitRaw(['checkout', '-q', 'main'])
  await up.gitRaw(['rm', '-q', '--', LOCAL_ONLY])
  await up.write('src/config/a.ts', 'a upstream\n')
  await up.commitAll('upstream removes a file')
}

async function run(
  overrides: Record<string, unknown> = {},
  options: { confirmDeletes?: (count: number) => Promise<boolean> } = {},
) {
  return new SyncOrchestrator({ config: config(overrides), cwd: down.root, ...options }).run()
}

function skippedDeletes(plan: { skipped: Array<{ path: string, reason: string, detail?: string }> }) {
  return plan.skipped.filter(item => item.reason === 'delete-protected')
}

describe('deletePolicy: mirror（默认，跟随上游删除）', () => {
  it('上游删掉的本地文件同步后消失', async () => {
    await upstreamDeletesAFile()

    const result = await run()

    expect(result.plan.changes.filter(entry => entry.kind === ChangeKind.DELETE).map(entry => entry.path))
      .toEqual([LOCAL_ONLY])
    expect(await down.exists(LOCAL_ONLY)).toBe(false)
    expect(await down.read('src/config/a.ts')).toBe('a upstream\n')
    expect(result.commit?.created).toBe(true)
  })

  it('本地对该文件有未提交改动时冲突会被报出来，选择采用上游就必须真的删掉', async () => {
    await upstreamDeletesAFile()
    await down.write(LOCAL_ONLY, 'to be deleted upstream\nlocal edit\n')

    const result = await run({
      conflictResolutionConfig: { defaultStrategy: ConflictResolutionStrategy.USE_SOURCE },
    })

    expect(result.plan.conflicts.map(conflict => conflict.path)).toEqual([LOCAL_ONLY])
    // `git rm` 对脏文件默认拒绝，这里不能整批失败后把文件留下。
    expect(result.applied?.applied.filter(item => item.status === 'failed')).toEqual([])
    expect(await down.exists(LOCAL_ONLY)).toBe(false)
  })
})

describe('deletePolicy: keep（本地文件一律保留）', () => {
  it('删除变成 skipped: delete-protected，其余改动照常同步', async () => {
    await upstreamDeletesAFile()

    const result = await run({ deletePolicy: 'keep' })

    expect(await down.exists(LOCAL_ONLY)).toBe(true)
    expect(await down.read(LOCAL_ONLY)).toBe('to be deleted upstream\n')
    expect(skippedDeletes(result.plan)).toEqual([expect.objectContaining({
      path: LOCAL_ONLY,
      detail: expect.stringContaining('deletePolicy 为 keep'),
    })])
    expect(result.plan.changes.map(entry => entry.path)).toEqual(['src/config/a.ts'])
    expect(await down.read('src/config/a.ts')).toBe('a upstream\n')
  })

  it('第二次运行仍然保留，也不会反复提交同一个删除决定', async () => {
    await upstreamDeletesAFile()
    await run({ deletePolicy: 'keep' })

    const again = await run({ deletePolicy: 'keep' })

    expect(await down.exists(LOCAL_ONLY)).toBe(true)
    expect(again.plan.changes).toHaveLength(0)
    expect(again.commit?.created).toBe(false)
    expect(skippedDeletes(again.plan)).toEqual([expect.objectContaining({ path: LOCAL_ONLY })])
  })

  it('keep 会关掉改名识别：否则"保留本地文件"的承诺会被一次搬家绕过', async () => {
    const { config: cfg, warnings } = resolveConfig({
      upstreamRepo: up.root,
      upstreamBranch: 'main',
      companyBranch: 'company',
      syncDirs: ['src/config'],
      deletePolicy: 'keep',
    })

    expect(cfg.renameDetection).toBe(false)
    expect(warnings.join('\n')).toContain('deletePolicy 为 keep 时已关闭重命名识别')
  })

  it('上游改名时，keep 保留旧路径、并带上上游的新内容', async () => {
    await up.gitRaw(['checkout', '-q', 'main'])
    up.gitRaw(['mv', 'src/config/a.ts', 'src/config/renamed.ts'])
    await up.commitAll('upstream renames')

    const result = await run({ deletePolicy: 'keep' })

    expect(result.plan.changes.filter(entry => entry.kind === ChangeKind.RENAME)).toEqual([])
    expect(await down.exists('src/config/a.ts')).toBe(true)
    expect(await down.read('src/config/renamed.ts')).toBe('a base\n')
  })
})

describe('deletePolicy: ask（每次问一次）', () => {
  it('回答"删"就按 mirror 执行，并把删除数量报给询问方', async () => {
    await upstreamDeletesAFile()
    const asked: number[] = []

    const result = await run(
      { deletePolicy: 'ask', nonInteractive: false },
      {
        confirmDeletes: async (count) => {
          asked.push(count)
          return true
        },
      },
    )

    expect(asked).toEqual([1])
    expect(await down.exists(LOCAL_ONLY)).toBe(false)
    expect(skippedDeletes(result.plan)).toEqual([])
  })

  it('回答"不删"就保留本地文件，其余改动照常落地', async () => {
    await upstreamDeletesAFile()

    const result = await run(
      { deletePolicy: 'ask', nonInteractive: false },
      { confirmDeletes: async () => false },
    )

    expect(await down.exists(LOCAL_ONLY)).toBe(true)
    expect(skippedDeletes(result.plan)).toEqual([expect.objectContaining({
      path: LOCAL_ONLY,
      detail: expect.stringContaining('选择保留'),
    })])
    expect(await down.read('src/config/a.ts')).toBe('a upstream\n')
    expect(result.commit?.created).toBe(true)
  })

  it('问不出答案时（非交互、--json、没有回调）默认保留并警告', async () => {
    await upstreamDeletesAFile()
    const asked: number[] = []

    const result = await run(
      { deletePolicy: 'ask', nonInteractive: true },
      { confirmDeletes: async (count) => {
        asked.push(count)
        return true
      } },
    )

    expect(asked).toEqual([])
    expect(await down.exists(LOCAL_ONLY)).toBe(true)
    expect(skippedDeletes(result.plan)).toEqual([expect.objectContaining({
      path: LOCAL_ONLY,
      detail: expect.stringContaining('无法询问'),
    })])
  })

  it('预览模式不问：计划里如实显示"会删掉这个文件"', async () => {
    await upstreamDeletesAFile()
    const asked: number[] = []

    const result = await run(
      { deletePolicy: 'ask', previewOnly: true, nonInteractive: false },
      {
        confirmDeletes: async (count) => {
          asked.push(count)
          return true
        },
      },
    )

    expect(asked).toEqual([])
    expect(result.plan.changes.filter(entry => entry.kind === ChangeKind.DELETE)).toHaveLength(1)
    expect(await down.exists(LOCAL_ONLY)).toBe(true)
  })

  it('上游没有删任何东西时不打扰用户', async () => {
    await up.gitRaw(['checkout', '-q', 'main'])
    await up.write('src/config/a.ts', 'a upstream\n')
    await up.commitAll('only a modification')
    const asked: number[] = []

    await run({ deletePolicy: 'ask', nonInteractive: false }, {
      confirmDeletes: async () => {
        asked.push(1)
        return true
      },
    })

    expect(asked).toEqual([])
  })
})
