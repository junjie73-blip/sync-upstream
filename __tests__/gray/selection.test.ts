import type { ChangeEntry, ConflictCandidate, SkippedEntry, SyncPlan } from '../../src/domain'
import { ChangeKind, ConflictType, GrayReleaseStage, GrayReleaseStrategy } from '../../src/domain'
import { ValidationError } from '../../src/errors'
import { bucketOf, selectCanary, stageProgress } from '../../src/gray/selection'

function plan(paths: string[]): SyncPlan {
  const changes: ChangeEntry[] = paths.map(repoPath => ({
    kind: ChangeKind.ADD,
    path: repoPath,
    scope: repoPath.slice(0, repoPath.lastIndexOf('/')),
    upstreamOid: `oid-${repoPath}`,
  }))
  const conflicts: ConflictCandidate[] = [{ path: paths[0], conflictType: ConflictType.CONTENT }]
  const skipped: SkippedEntry[] = [{ path: paths[0], reason: 'ignored' }]
  return {
    upstreamRef: 'upstream/main',
    targetBranch: 'company',
    changes,
    conflicts,
    skipped,
    dirty: paths,
  }
}

describe('bucketOf', () => {
  it('同一路径永远落在同一桶，取值范围 [0,100)', () => {
    expect(bucketOf('src/a.ts')).toBe(bucketOf('src/a.ts'))
    for (const repoPath of ['src/a.ts', 'src/b.ts', 'docs/c.md', 'build/d.js'])
      expect(bucketOf(repoPath)).toBeGreaterThanOrEqual(0)
  })

  it('不同路径分散在 0..99，不会全部塞进一个桶', () => {
    const buckets = new Set(Array.from({ length: 40 }, (_, index) => bucketOf(`src/file-${index}.ts`)))
    expect(buckets.size).toBeGreaterThan(5)
  })
})

describe('selectCanary', () => {
  it('percentage=100 时全部进入金丝雀，pending 为空', () => {
    const selection = selectCanary(plan(['src/a.ts', 'src/b.ts']), {
      enable: true,
      strategy: GrayReleaseStrategy.PERCENTAGE,
      percentage: 100,
    })
    expect(selection.canary.changes).toHaveLength(2)
    expect(selection.pending.changes).toHaveLength(0)
    expect(selection.releaseId).toBeTruthy()
  })

  it('按 percentage 切分，两份计划互不重叠且并集等于原计划', () => {
    const paths = Array.from({ length: 60 }, (_, index) => `src/f${index}.ts`)
    const selection = selectCanary(plan(paths), {
      enable: true,
      strategy: GrayReleaseStrategy.PERCENTAGE,
      percentage: 30,
    })
    const canary = selection.canary.changes.map(entry => entry.path)
    const pending = selection.pending.changes.map(entry => entry.path)

    expect(canary.every(repoPath => bucketOf(repoPath) < 30)).toBe(true)
    expect(new Set([...canary, ...pending]).size).toBe(paths.length)
    expect(canary.filter(repoPath => pending.includes(repoPath))).toHaveLength(0)
  })

  it('directory 策略按 scope 命中', () => {
    const selection = selectCanary(plan(['src/ui/a.ts', 'src/core/b.ts']), {
      enable: true,
      strategy: GrayReleaseStrategy.DIRECTORY,
      canaryDirs: ['src/ui/'],
    })
    expect(selection.canary.changes.map(entry => entry.path)).toEqual(['src/ui/a.ts'])
    expect(selection.pending.changes.map(entry => entry.path)).toEqual(['src/core/b.ts'])
  })

  it('file 策略支持后缀通配、精确文件名与路径后缀', () => {
    const base = { enable: true, strategy: GrayReleaseStrategy.FILE } as const
    expect(selectCanary(plan(['src/a.ts', 'src/b.md']), { ...base, filePatterns: ['*.ts'] })
      .canary.changes.map(entry => entry.path)).toEqual(['src/a.ts'])
    expect(selectCanary(plan(['src/a.ts', 'src/b.md']), { ...base, filePatterns: ['b.md'] })
      .canary.changes.map(entry => entry.path)).toEqual(['src/b.md'])
    expect(selectCanary(plan(['src/a.ts', 'other/a.ts']), { ...base, filePatterns: ['src/a.ts'] })
      .canary.changes.map(entry => entry.path)).toEqual(['src/a.ts'])
  })

  it('冲突/跳过/dirty 信息随路径集合一起切分', () => {
    const selection = selectCanary(plan(['src/a.ts', 'src/b.ts']), {
      enable: true,
      strategy: GrayReleaseStrategy.PERCENTAGE,
      percentage: 100,
    })
    expect(selection.canary.conflicts).toHaveLength(1)
    expect(selection.canary.skipped).toHaveLength(1)
    expect(selection.canary.dirty).toEqual(['src/a.ts', 'src/b.ts'])
    expect(selection.pending.conflicts).toEqual([])
  })

  it('percentage 非法时立刻报错，而不是静默选出 0 个文件把灰度卡死', () => {
    const bad = (percentage?: number) => selectCanary(plan(['src/a.ts']), {
      enable: true,
      strategy: GrayReleaseStrategy.PERCENTAGE,
      percentage,
    })
    expect(() => bad(0)).toThrow(/percentage 必须在/)
    expect(() => bad(101)).toThrow(/percentage 必须在/)
    expect(() => bad(undefined)).toThrow(ValidationError)
  })

  it('directory / file 策略缺少列表时报错', () => {
    expect(() => selectCanary(plan(['src/a.ts']), {
      enable: true,
      strategy: GrayReleaseStrategy.DIRECTORY,
      canaryDirs: [],
    })).toThrow(/canaryDirs/)
    expect(() => selectCanary(plan(['src/a.ts']), {
      enable: true,
      strategy: GrayReleaseStrategy.FILE,
    })).toThrow(/filePatterns/)
  })

  it('没有任何文件落入金丝雀集合时给出可操作的错误', () => {
    const [only] = plan(['src/a.ts']).changes
    const percentage = bucketOf(only.path)
    expect(() => selectCanary(plan(['src/a.ts']), {
      enable: true,
      strategy: GrayReleaseStrategy.PERCENTAGE,
      percentage,
    })).toThrow(/灰度选择结果为空/)
  })
})

describe('stageProgress', () => {
  it('已完成阶段恒为 100，空计划视为完成', () => {
    expect(stageProgress(GrayReleaseStage.COMPLETED, 0, 10)).toBe(100)
    expect(stageProgress(GrayReleaseStage.CANARY, 0, 0)).toBe(100)
  })

  it('按比例计算并封顶 100', () => {
    expect(stageProgress(GrayReleaseStage.CANARY, 1, 3)).toBe(33.33)
    expect(stageProgress(GrayReleaseStage.CANARY, 5, 3)).toBe(100)
  })
})
