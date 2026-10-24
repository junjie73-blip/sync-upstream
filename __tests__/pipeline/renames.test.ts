import type { ChangeEntry, RenamePair } from '../../src/domain'
import { ChangeKind } from '../../src/domain'
import { parseNameStatus } from '../../src/git/repository'
import { foldRenames, renameNeedsContent } from '../../src/pipeline/renames'

/** `git diff --name-status -z` writes one NUL-terminated field per token. */
function nul(...tokens: string[]): string {
  return tokens.map(token => `${token}\0`).join('')
}

const pair = (from: string, to: string, similarity: number): RenamePair => ({ from, to, similarity })

function entry(fields: Partial<ChangeEntry> & Pick<ChangeEntry, 'kind' | 'path'>): ChangeEntry {
  return { scope: 'src/config', ...fields }
}

describe('parseNameStatus：把 git 的改名记录读成配对', () => {
  it('单路径记录各占一格，不会被当成改名', () => {
    expect(parseNameStatus(nul('M', 'a.ts', 'D', 'b.ts', 'A', 'c.ts'))).toEqual([])
    expect(parseNameStatus('')).toEqual([])
  })

  it('以 R / C 开头的路径不会被误认成状态码（README.md 曾被当成一条改名）', () => {
    expect(parseNameStatus(nul('A', 'README.md'))).toEqual([])
    expect(parseNameStatus(nul('D', 'COPYING', 'M', 'src/Routes.tsx'))).toEqual([])
  })

  it('R100 配对成纯搬家，相似度原样带出', () => {
    expect(parseNameStatus(nul('R100', 'src/a.ts', 'src/b.ts'))).toEqual([pair('src/a.ts', 'src/b.ts', 100)])
  })

  it('混合流里只取改名，其余记录继续按一格路径消费', () => {
    expect(parseNameStatus(nul('A', 'x.ts', 'R085', 'src/a.ts', 'src/b.ts', 'M', 'c.ts', 'R091', 'd.ts', 'e.ts')))
      .toEqual([pair('src/a.ts', 'src/b.ts', 85), pair('d.ts', 'e.ts', 91)])
  })

  it('拷贝记录可能带两个分数，取最后一个作为本对的相似度', () => {
    expect(parseNameStatus(nul('C75,90', 'src/a.ts', 'src/c.ts'))).toEqual([pair('src/a.ts', 'src/c.ts', 90)])
  })

  it('空格与引号都不影响路径，-z 的价值就在这里', () => {
    expect(parseNameStatus(nul('R100', 'src/my "old".ts', 'src/my old.ts')))
      .toEqual([pair('src/my "old".ts', 'src/my old.ts', 100)])
  })

  it('缺路径、缺分数或自己指向自己时直接停住，绝不猜一个配对出来', () => {
    expect(parseNameStatus(nul('R100', 'only-one-path.ts'))).toEqual([])
    expect(parseNameStatus(nul('R', 'src/a.ts', 'src/b.ts'))).toEqual([])
    expect(parseNameStatus(nul('R100', 'same.ts', 'same.ts'))).toEqual([])
    // 第一条就错位：后面的路径全都不能再当状态码读。
    expect(parseNameStatus(nul('src/not-a-status.ts', 'src/a.ts'))).toEqual([])
  })
})

describe('foldRenames：把删除+新增配对成一条改名', () => {
  const deleted = entry({ kind: ChangeKind.DELETE, path: 'src/config/old.ts', targetOid: 'a1', targetMode: '100644' })
  const added = entry({ kind: ChangeKind.ADD, path: 'src/config/new.ts', upstreamOid: 'b2', upstreamMode: '100755', objectType: 'blob' })
  const untouched = entry({ kind: ChangeKind.MODIFY, path: 'src/config/keep.ts', upstreamOid: 'c3', targetOid: 'c0' })

  it('没有配对时原样返回同一个数组', () => {
    const changes = [deleted, added]
    expect(foldRenames(changes, [])).toBe(changes)
  })

  it('两半都在计划里时合成一条 RENAME，字段各取所属的一侧', () => {
    const folded = foldRenames([deleted, added, untouched], [pair(deleted.path, added.path, 100)])

    expect(folded).toHaveLength(2)
    expect(folded.map(item => item.path)).toEqual(['src/config/keep.ts', 'src/config/new.ts'])
    expect(folded.find(item => item.path === 'src/config/new.ts')).toEqual({
      kind: ChangeKind.RENAME,
      path: 'src/config/new.ts',
      scope: 'src/config',
      fromPath: 'src/config/old.ts',
      similarity: 100,
      // 新路径的内容来自上游，旧路径的记录来自目标分支——后者是"本地文件本来长什么样"。
      upstreamOid: 'b2',
      upstreamMode: '100755',
      targetOid: 'a1',
      targetMode: '100644',
      objectType: 'blob',
    })
  })

  it('只有一半在计划里时不折叠：被忽略或被增量跳过的路径没有东西可搬', () => {
    const cases = [
      [added],
      [deleted],
      [entry({ ...deleted, path: 'src/config/somewhere-else.ts' }), added],
    ]
    for (const changes of cases) {
      expect(foldRenames(changes, [pair('src/config/old.ts', 'src/config/new.ts', 100)])).toBe(changes)
    }
  })

  it('多对配对后按新路径排序，预览与提交顺序稳定', () => {
    const changes = [
      entry({ kind: ChangeKind.DELETE, path: 'src/config/z-old.ts' }),
      entry({ kind: ChangeKind.ADD, path: 'src/config/z-new.ts' }),
      entry({ kind: ChangeKind.DELETE, path: 'src/config/a-old.ts' }),
      entry({ kind: ChangeKind.ADD, path: 'src/config/a-new.ts' }),
    ]
    const folded = foldRenames(changes, [
      pair('src/config/z-old.ts', 'src/config/z-new.ts', 100),
      pair('src/config/a-old.ts', 'src/config/a-new.ts', 95),
    ])

    expect(folded.map(item => item.path)).toEqual(['src/config/a-new.ts', 'src/config/z-new.ts'])
    expect(folded.every(item => item.kind === ChangeKind.RENAME)).toBe(true)
  })
})

describe('renameNeedsContent：纯搬家不必再写内容', () => {
  const rename = (fields: Partial<ChangeEntry>): ChangeEntry => entry({
    kind: ChangeKind.RENAME,
    path: 'src/config/new.ts',
    fromPath: 'src/config/old.ts',
    similarity: 100,
    upstreamOid: 'same',
    targetOid: 'same',
    ...fields,
  })

  it('相似度 100 且两侧 blob 相同：git mv 之后内容已经是对的', () => {
    expect(renameNeedsContent(rename({}))).toBe(false)
  })

  it('改名同时改内容：需要把上游版本写到新路径', () => {
    expect(renameNeedsContent(rename({ upstreamOid: 'other' }))).toBe(true)
    expect(renameNeedsContent(rename({ similarity: 92 }))).toBe(true)
  })

  it('非改名条目一律返回 false', () => {
    expect(renameNeedsContent(entry({ kind: ChangeKind.MODIFY, path: 'src/config/a.ts', similarity: 100 }))).toBe(false)
  })
})
