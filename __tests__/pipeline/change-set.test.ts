import type { ChangeEntry, RepoPath } from '../../src/domain'
import type { GitObjectType, TreeEntry } from '../../src/git/repository'
import { ChangeKind } from '../../src/domain'
import { countByKind, diffTrees, gitlinkPaths, groupByScope } from '../../src/pipeline/change-set'

function entry(oid: string, mode = '100644', type: GitObjectType = 'blob'): TreeEntry {
  return { oid, mode, type }
}

function tree(entries: Record<string, string>): Map<RepoPath, TreeEntry> {
  return new Map(Object.entries(entries).map(([repoPath, oid]) => [repoPath, entry(oid)]))
}

const SCOPES = ['src/config', 'src/ui', 'build']

describe('diffTrees', () => {
  it('上游有、目标没有 => ADD，并带上所属 scope、mode 与对象类型', () => {
    const changes = diffTrees(tree({}), tree({ 'src/config/a.ts': 'aaa' }), SCOPES)
    expect(changes).toEqual([{
      kind: ChangeKind.ADD,
      path: 'src/config/a.ts',
      scope: 'src/config',
      upstreamOid: 'aaa',
      upstreamMode: '100644',
      objectType: 'blob',
    }])
  })

  it('oid 或 mode 不同 => MODIFY', () => {
    const byContent = diffTrees(tree({ 'src/ui/a.ts': 'old' }), tree({ 'src/ui/a.ts': 'new' }), SCOPES)
    expect(byContent).toHaveLength(1)
    expect(byContent[0].kind).toBe(ChangeKind.MODIFY)
    expect(byContent[0].targetOid).toBe('old')
    expect(byContent[0].upstreamOid).toBe('new')

    const byMode = diffTrees(
      new Map([['src/ui/x.sh', entry('same', '100644')]]),
      new Map([['src/ui/x.sh', entry('same', '100755')]]),
      SCOPES,
    )
    expect(byMode).toHaveLength(1)
    expect(byMode[0].kind).toBe(ChangeKind.MODIFY)
    expect(byMode[0].upstreamMode).toBe('100755')
    expect(byMode[0].targetMode).toBe('100644')
    // mode 变化必须落到决策字段上，否则 apply 层无从得知要改可执行位
    expect(byMode[0].objectType).toBe('blob')
  })

  it('符号链接照常参与同步', () => {
    const changes = diffTrees(
      new Map<string, TreeEntry>(),
      new Map([['src/ui/link', entry('lid', '120000', 'link')]]),
      SCOPES,
    )
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ path: 'src/ui/link', upstreamMode: '120000', objectType: 'link' })
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
      targetMode: '100644',
      objectType: 'blob',
    }])
  })

  it('子模块 gitlink 两侧都不产生变更，交给 gitlinkPaths 上报', () => {
    const changes = diffTrees(
      new Map<string, TreeEntry>(),
      new Map([['vendor/pkg', entry('sha', '160000', 'commit')]]),
      SCOPES,
    )
    expect(changes).toEqual([])
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

describe('gitlinkPaths', () => {
  it('收集任一侧的 gitlink 并按路径去重', () => {
    const found = gitlinkPaths(
      new Map([['vendor/a', entry('1', '160000', 'commit')], ['src/config/x.ts', entry('2')]]),
      new Map([['vendor/a', entry('3', '160000', 'commit')], ['vendor/b', entry('4', '160000', 'commit')]]),
    )
    expect(found).toEqual([{ path: 'vendor/a', type: 'commit' }, { path: 'vendor/b', type: 'commit' }])
  })

  it('没有子模块时返回空数组', () => {
    expect(gitlinkPaths(tree({ 'src/config/a.ts': 'aaa' }))).toEqual([])
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
    // 每种类型都会出现，没有变更的类型记 0 —— 报告里可以直接读，不必再判空。
    expect(countByKind(changes)).toEqual({
      [ChangeKind.ADD]: 1,
      [ChangeKind.MODIFY]: 1,
      [ChangeKind.DELETE]: 1,
      [ChangeKind.RENAME]: 0,
    })
    expect(countByKind([])[ChangeKind.ADD]).toBe(0)
  })
})
