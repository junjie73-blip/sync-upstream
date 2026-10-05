import type { ChangeEntry, RepoPath } from '../../src/domain'
import type { TreeEntry } from '../../src/git/repository'
import { ChangeKind } from '../../src/domain'
import { countByKind, diffTrees, groupByScope } from '../../src/pipeline/change-set'

function tree(entries: Record<string, string>): Map<RepoPath, TreeEntry> {
  return new Map(Object.entries(entries).map(([repoPath, oid]) => [repoPath, { oid, mode: '100644' }]))
}

const SCOPES = ['src/config', 'src/ui', 'build']

describe('diffTrees', () => {
  it('上游有、目标没有 => ADD，并带上所属 scope', () => {
    const changes = diffTrees(tree({}), tree({ 'src/config/a.ts': 'aaa' }), SCOPES)
    expect(changes).toEqual([{
      kind: ChangeKind.ADD,
      path: 'src/config/a.ts',
      scope: 'src/config',
      upstreamOid: 'aaa',
    }])
  })

  it('oid 或 mode 不同 => MODIFY', () => {
    const byContent = diffTrees(tree({ 'src/ui/a.ts': 'old' }), tree({ 'src/ui/a.ts': 'new' }), SCOPES)
    expect(byContent).toHaveLength(1)
    expect(byContent[0].kind).toBe(ChangeKind.MODIFY)
    expect(byContent[0].targetOid).toBe('old')
    expect(byContent[0].upstreamOid).toBe('new')

    const byMode = diffTrees(
      new Map([['src/ui/x.sh', { oid: 'same', mode: '100644' }]]),
      new Map([['src/ui/x.sh', { oid: 'same', mode: '100755' }]]),
      SCOPES,
    )
    expect(byMode[0].kind).toBe(ChangeKind.MODIFY)
  })

  it('内容一致的文件不产生任何变更（这是增量同步的判定基础）', () => {
    expect(diffTrees(tree({ 'src/config/a.ts': 'same' }), tree({ 'src/config/a.ts': 'same' }), SCOPES)).toEqual([])
  })

  it('目标有、上游没有 => DELETE', () => {
    const changes = diffTrees(tree({ 'build/out.js': 'bbb' }), tree({}), SCOPES)
    expect(changes).toEqual([{
      kind: ChangeKind.DELETE,
      path: 'build/out.js',
      scope: 'build',
      targetOid: 'bbb',
    }])
  })

  it('scope 之外的文件完全不参与比较', () => {
    const changes = diffTrees(tree({ 'docs/a.md': 'x' }), tree({ 'docs/b.md': 'y', 'src/other/z.ts': 'q' }), SCOPES)
    expect(changes).toEqual([])
  })

  it('最长 scope 优先：src/config 的文件不会挂到 src 上', () => {
    const [change] = diffTrees(tree({}), tree({ 'src/config/deep/x.ts': 'a' }), ['src', 'src/config'])
    expect(change.scope).toBe('src/config')
  })

  it('结果按路径稳定排序，预览与实际应用顺序一致', () => {
    const changes = diffTrees(tree({}), tree({ 'build/z.js': '1', 'build/a.js': '2', 'build/m.js': '3' }), SCOPES)
    expect(changes.map(change => change.path)).toEqual(['build/a.js', 'build/m.js', 'build/z.js'])
  })
})

describe('groupByScope / countByKind', () => {
  const changes: ChangeEntry[] = [
    { kind: ChangeKind.ADD, path: 'src/config/a.ts', scope: 'src/config' },
    { kind: ChangeKind.MODIFY, path: 'src/ui/b.ts', scope: 'src/ui' },
    { kind: ChangeKind.DELETE, path: 'src/ui/c.ts', scope: 'src/ui' },
  ]

  it('按 scope 分组', () => {
    const grouped = groupByScope(changes)
    expect([...grouped.keys()].sort()).toEqual(['src/config', 'src/ui'])
    expect(grouped.get('src/ui')).toHaveLength(2)
  })

  it('统计每种类型的数量', () => {
    expect(countByKind(changes)).toEqual({
      [ChangeKind.ADD]: 1,
      [ChangeKind.MODIFY]: 1,
      [ChangeKind.DELETE]: 1,
    })
    expect(countByKind([])[ChangeKind.ADD]).toBe(0)
  })
})
