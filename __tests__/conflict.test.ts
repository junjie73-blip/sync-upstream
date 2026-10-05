import type {
  ConflictCandidate,
  ConflictContentSource,
  ConflictDecision,
  ConflictRecord,
  ConflictResolutionConfig,
} from '../src/domain/conflict'
import { ConflictResolver, conflictSummary, formatConflictReport, threeWayMerge } from '../src/conflict'
import { ConflictResolutionStrategy, ConflictType } from '../src/domain/conflict'
import { ValidationError } from '../src/errors'

interface FakeFiles {
  base?: string | null
  local?: string | null
  upstream?: string | null
}

/** 内存版内容源：null 或缺失都表示该侧没有这个文件。 */
function fakeContents(files: Record<string, FakeFiles>): ConflictContentSource {
  const read = (side: keyof FakeFiles) => async (path: string): Promise<string | null> => files[path]?.[side] ?? null
  return { base: read('base'), local: read('local'), upstream: read('upstream') }
}

function candidate(path: string, conflictType: ConflictType = ConflictType.CONTENT): ConflictCandidate {
  return { path, conflictType }
}

function config(overrides: Partial<ConflictResolutionConfig> = {}): ConflictResolutionConfig {
  return { defaultStrategy: ConflictResolutionStrategy.USE_SOURCE, ...overrides }
}

describe('threeWayMerge', () => {
  it('双方一致时返回 clean', () => {
    const r = threeWayMerge('a\nb\n', 'a\nb\n', 'a\nb\n')
    expect(r.status).toBe('clean')
    expect(r.content).toBe('a\nb\n')

    const sameAdd = threeWayMerge(null, 'x\n', 'x\n')
    expect(sameAdd.status).toBe('clean')
    expect(sameAdd.content).toBe('x\n')
  })

  it('仅一侧改动时取该侧内容', () => {
    const localOnly = threeWayMerge('a\nb\n', 'a\nB\n', 'a\nb\n')
    expect(localOnly.status).toBe('clean')
    expect(localOnly.content).toBe('a\nB\n')

    const upstreamOnly = threeWayMerge('a\nb\n', 'a\nb\n', 'a\nB\n')
    expect(upstreamOnly.status).toBe('clean')
    expect(upstreamOnly.content).toBe('a\nB\n')
  })

  it('双方改动不相交区域时自动合并成功', () => {
    const r = threeWayMerge('a\nb\nc\nd\n', 'A\nb\nc\nd\n', 'a\nb\nc\nD\n')
    expect(r.status).toBe('clean')
    expect(r.content).toBe('A\nb\nc\nD\n')
  })

  it('双方改动同一区域时输出标准冲突标记并计数', () => {
    const r = threeWayMerge('a\nb\nc\n', 'a1\nb\nc\n', 'a2\nb\nc\n')
    expect(r.status).toBe('conflict')
    expect(r.conflictCount).toBe(1)
    expect(r.content).toContain('<<<<<<< LOCAL')
    expect(r.content).toContain('=======')
    expect(r.content).toContain('>>>>>>> UPSTREAM')
    expect(r.content).toContain('a1')
    expect(r.content).toContain('a2')
  })

  it('多处独立冲突分别计数', () => {
    const r = threeWayMerge('a\nb\nc\nd\n', 'A\nb\nC\nd\n', 'X\nb\nY\nd\n')
    expect(r.status).toBe('conflict')
    expect(r.conflictCount).toBe(2)
  })

  it('超大输入不再逐行合并，而是输出整文件冲突标记（且不挂起）', () => {
    const big = Array.from({ length: 20_001 }, (_, i) => `l${i}`).join('\n')
    const r = threeWayMerge('a\nb\nc', big, 'x\ny\nz')
    expect(r.status).toBe('conflict')
    expect(r.conflictCount).toBe(1)
    expect(r.content).toContain('<<<<<<< LOCAL')
    expect(r.content).toContain('l0')
    expect(r.content).toContain('l20000')
    expect(r.content).toContain('x\ny\nz')
  })

  it('一侧删除另一侧修改视为冲突，两侧都删除返回 both-deleted', () => {
    const delModify = threeWayMerge('a\n', null, 'b\n')
    expect(delModify.status).toBe('conflict')
    expect(delModify.content).toContain('<<<<<<< LOCAL')
    expect(delModify.content).toContain('b')

    const deleted = threeWayMerge('a\n', null, null)
    expect(deleted.status).toBe('both-deleted')
  })

  it('一侧删除另一侧未改动时接受删除（clean 无内容）', () => {
    const r = threeWayMerge('a\n', null, 'a\n')
    expect(r.status).toBe('clean')
    expect(r.content).toBeUndefined()
  })

  it('含 NUL 字节的内容返回 binary', () => {
    const r = threeWayMerge('a\n', 'a\u0000b\n', 'c\n')
    expect(r.status).toBe('binary')
  })
})

describe('ConflictResolver', () => {
  it('USE_SOURCE 采用上游', async () => {
    const decisions = await new ConflictResolver(config()).resolve([candidate('f.txt')], fakeContents({}))
    expect(decisions).toEqual([
      {
        path: 'f.txt',
        conflictType: ConflictType.CONTENT,
        strategy: ConflictResolutionStrategy.USE_SOURCE,
        action: 'take-upstream',
        detail: '采用上游版本',
      },
    ])
  })

  it('KEEP_TARGET 与 SKIP 分别映射为 keep-local 和 skip', async () => {
    const keep = new ConflictResolver(config({ defaultStrategy: ConflictResolutionStrategy.KEEP_TARGET }))
    const skip = new ConflictResolver(config({ defaultStrategy: ConflictResolutionStrategy.SKIP }))
    const [keepDecision] = await keep.resolve([candidate('f.txt')], fakeContents({}))
    const [skipDecision] = await skip.resolve([candidate('f.txt')], fakeContents({}))
    expect(keepDecision.action).toBe('keep-local')
    expect(skipDecision.action).toBe('skip')
  })

  describe('AUTO_MERGE', () => {
    const auto = (): ConflictResolutionConfig => config({ defaultStrategy: ConflictResolutionStrategy.AUTO_MERGE })

    it('clean（仅上游改动）→ take-upstream', async () => {
      const contents = fakeContents({ 'f.ts': { base: 'a\n', local: 'a\n', upstream: 'b\n' } })
      const [d] = await new ConflictResolver(auto()).resolve([candidate('f.ts')], contents)
      expect(d.action).toBe('take-upstream')
    })

    it('clean（仅本地改动）→ keep-local', async () => {
      const contents = fakeContents({ 'f.ts': { base: 'a\n', local: 'b\n', upstream: 'a\n' } })
      const [d] = await new ConflictResolver(auto()).resolve([candidate('f.ts')], contents)
      expect(d.action).toBe('keep-local')
    })

    it('conflict → write-merged，带冲突标记内容与冲突数 detail', async () => {
      const contents = fakeContents({ 'f.ts': { base: 'a\n', local: 'l\n', upstream: 'u\n' } })
      const [d] = await new ConflictResolver(auto()).resolve([candidate('f.ts')], contents)
      expect(d.action).toBe('write-merged')
      expect(d.mergedContent).toContain('<<<<<<< LOCAL')
      expect(d.mergedContent).toContain('>>>>>>> UPSTREAM')
      expect(d.detail).toContain('1 处冲突')
    })

    it('both-deleted → skip', async () => {
      const contents = fakeContents({ 'f.ts': { base: 'a\n', local: null, upstream: null } })
      const [d] = await new ConflictResolver(auto()).resolve([candidate('f.ts')], contents)
      expect(d.action).toBe('skip')
    })

    it('binary → skip 并说明原因', async () => {
      const contents = fakeContents({ 'f.bin': { base: null, local: 'a\u0000', upstream: 'b' } })
      const [d] = await new ConflictResolver(auto()).resolve([candidate('f.bin')], contents)
      expect(d.action).toBe('skip')
      expect(d.detail).toContain('二进制')
    })
  })

  describe('PROMPT_USER', () => {
    const promptConfig = (): ConflictResolutionConfig => config({ defaultStrategy: ConflictResolutionStrategy.PROMPT_USER })

    it('每个候选恰好提示一次，绝不递归', async () => {
      const prompt = jest.fn(
        async (_candidate: ConflictCandidate): Promise<ConflictResolutionStrategy | null> =>
          ConflictResolutionStrategy.USE_SOURCE,
      )
      const resolver = new ConflictResolver(promptConfig(), { prompt })
      const decisions = await resolver.resolve([candidate('a.txt'), candidate('b.txt')], fakeContents({}))
      expect(prompt).toHaveBeenCalledTimes(2)
      expect(prompt.mock.calls.map(call => call[0].path)).toEqual(['a.txt', 'b.txt'])
      expect(decisions.every(d => d.action === 'take-upstream')).toBe(true)
    })

    it('用户未选择（null）时保留本地版本', async () => {
      const prompt = jest.fn(
        async (_candidate: ConflictCandidate): Promise<ConflictResolutionStrategy | null> => null,
      )
      const [d] = await new ConflictResolver(promptConfig(), { prompt }).resolve([candidate('a.txt')], fakeContents({}))
      expect(d.action).toBe('keep-local')
      expect(d.detail).toBe('用户未选择，保留本地版本')
    })

    it('autoResolveTypes 命中的扩展名跳过提示', async () => {
      const prompt = jest.fn(
        async (_candidate: ConflictCandidate): Promise<ConflictResolutionStrategy | null> =>
          ConflictResolutionStrategy.USE_SOURCE,
      )
      const resolver = new ConflictResolver(
        { defaultStrategy: ConflictResolutionStrategy.PROMPT_USER, autoResolveTypes: ['.ts'] },
        { prompt },
      )
      const [d] = await resolver.resolve([candidate('x.ts')], fakeContents({}))
      expect(prompt).not.toHaveBeenCalled()
      expect(d.action).toBe('keep-local')
      expect(d.detail).toContain('未提示')
    })
  })

  it('未知策略值抛出 ValidationError', async () => {
    const resolver = new ConflictResolver(config({ defaultStrategy: 'not-a-strategy' as ConflictResolutionStrategy }))
    await expect(resolver.resolve([candidate('a.txt')], fakeContents({}))).rejects.toBeInstanceOf(ValidationError)
  })

  it('单个候选读取失败不中断整批，detail 以“处理失败”开头', async () => {
    const records: ConflictRecord[] = []
    const contents: ConflictContentSource = {
      base: async () => 'a\n',
      local: async (path) => {
        if (path === 'bad.txt')
          throw new Error('读取失败boom')
        return 'l\n'
      },
      upstream: async () => 'u\n',
    }
    const resolver = new ConflictResolver(
      config({ defaultStrategy: ConflictResolutionStrategy.AUTO_MERGE }),
      { onResolved: record => records.push(record) },
    )
    const decisions = await resolver.resolve([candidate('ok.txt'), candidate('bad.txt'), candidate('ok2.txt')], contents)

    expect(decisions).toHaveLength(3)
    const failures = decisions.filter(d => d.detail?.startsWith('处理失败'))
    expect(failures).toHaveLength(1)
    expect(failures[0].path).toBe('bad.txt')
    expect(failures[0].action).toBe('skip')
    expect(failures[0].detail).toContain('读取失败boom')
    // 每条决策（含失败项）都发出了 ConflictRecord
    expect(records.map(r => r.path)).toEqual(['ok.txt', 'bad.txt', 'ok2.txt'])
  })

  it('logResolutions 为 false 时不发出记录', async () => {
    const onResolved = jest.fn()
    await new ConflictResolver(config({ logResolutions: false }), { onResolved })
      .resolve([candidate('a.txt')], fakeContents({}))
    expect(onResolved).not.toHaveBeenCalled()
  })
})

describe('report', () => {
  const sample: ConflictDecision[] = [
    { path: 'a.ts', conflictType: ConflictType.CONTENT, strategy: ConflictResolutionStrategy.AUTO_MERGE, action: 'write-merged', detail: '自动合并存在 2 处冲突，已写入冲突标记' },
    { path: 'b.ts', conflictType: ConflictType.CONTENT, strategy: ConflictResolutionStrategy.USE_SOURCE, action: 'take-upstream', detail: '采用上游版本' },
    { path: 'c.md', conflictType: ConflictType.TYPE, strategy: ConflictResolutionStrategy.KEEP_TARGET, action: 'keep-local', detail: '保留本地版本' },
    { path: 'd.bin', conflictType: ConflictType.CONTENT, strategy: ConflictResolutionStrategy.SKIP, action: 'skip', detail: '二进制文件无法自动合并' },
  ]

  it('conflictSummary 统计四类动作且缺失为 0', () => {
    expect(conflictSummary(sample)).toEqual({
      'take-upstream': 1,
      'write-merged': 1,
      'keep-local': 1,
      'skip': 1,
    })
    expect(conflictSummary([])).toEqual({
      'take-upstream': 0,
      'write-merged': 0,
      'keep-local': 0,
      'skip': 0,
    })
  })

  it('formatConflictReport 每条决策一行并按动作分组', () => {
    const lines = formatConflictReport(sample)
    expect(lines).toHaveLength(4)
    // 分组顺序：take-upstream → write-merged → keep-local → skip
    expect(lines[0]).toContain('b.ts')
    expect(lines[0]).toContain('采用上游')
    expect(lines[1]).toContain('a.ts')
    expect(lines[2]).toContain('c.md')
    expect(lines[3]).toContain('d.bin')
  })
})
