import path from 'node:path'
import {
  ancestorsOf,
  extensionOf,
  isUnderScope,
  joinRepoPath,
  normalizeRepoPath,
  parentOf,
  scopeOf,
  toPosix,
  toSafeFileName,
} from '../../src/fsx/paths'

describe('normalizeRepoPath / toPosix', () => {
  it('统一为 posix 相对路径', () => {
    expect(toPosix('src\\a\\b.ts')).toBe('src/a/b.ts')
    expect(normalizeRepoPath('.\\src//config\\/')).toBe('src/config')
    expect(normalizeRepoPath('./a/b')).toBe('a/b')
    expect(normalizeRepoPath('  a/b  ')).toBe('a/b')
    expect(normalizeRepoPath('')).toBe('')
  })
})

describe('isUnderScope', () => {
  it('空 scope 覆盖全仓库', () => {
    expect(isUnderScope('any/file', '')).toBe(true)
    expect(isUnderScope('any/file', '.')).toBe(true)
  })

  it('只认目录边界，不把 src 的前缀当成 scope', () => {
    expect(isUnderScope('src/a', 'src')).toBe(true)
    expect(isUnderScope('src', 'src')).toBe(true)
    expect(isUnderScope('srcdemo/a', 'src')).toBe(false)
  })
})

describe('scopeOf', () => {
  it('取最长匹配的 scope，src 不会吞掉 src/config', () => {
    const scopes = ['src', 'src/config', 'build']
    expect(scopeOf('src/config/a.ts', scopes)).toBe('src/config')
    expect(scopeOf('src/other/a.ts', scopes)).toBe('src')
    expect(scopeOf('build/x.js', scopes)).toBe('build')
    expect(scopeOf('docs/x.md', scopes)).toBeNull()
  })
})

describe('parentOf / ancestorsOf', () => {
  it('根级文件没有父目录', () => {
    expect(parentOf('a.ts')).toBeNull()
    expect(parentOf('src/a.ts')).toBe('src')
    expect(ancestorsOf('a/b/c/d.ts')).toEqual(['a/b/c', 'a/b', 'a'])
    expect(ancestorsOf('a.ts')).toEqual([])
  })
})

describe('extensionOf', () => {
  it('大小写归一并只取最后一段扩展名', () => {
    expect(extensionOf('src/A.TSX')).toBe('.tsx')
    expect(extensionOf('a/b.test.ts')).toBe('.ts')
    expect(extensionOf('Makefile')).toBe('')
  })
})

describe('joinRepoPath', () => {
  it('把 RepoPath 拼成主机绝对路径，且不越出仓库根', () => {
    expect(joinRepoPath(path.join('a', 'repo'), 'src/config/x.ts'))
      .toBe(path.join('a', 'repo', 'src', 'config', 'x.ts'))
    expect(joinRepoPath(path.join('a', 'repo'), 'x.ts')).toBe(path.join('a', 'repo', 'x.ts'))
    expect(joinRepoPath(path.join('a', 'repo'), '')).toBe(path.join('a', 'repo'))
    expect(joinRepoPath(path.join('a', 'repo'), 'a\\b\\c')).toBe(path.join('a', 'repo', 'a', 'b', 'c'))
  })
})

describe('toSafeFileName', () => {
  it('Windows 非法字符全部替换', () => {
    expect(toSafeFileName('src/a:b?.ts')).toBe('src-a-b-.ts')
    const safe = toSafeFileName('a\\b:c*d?"e<f>g|.txt')
    expect(/[/\\:*?"<>|]/.test(safe)).toBe(false)
    expect(safe.endsWith('.txt')).toBe(true)
  })
})
