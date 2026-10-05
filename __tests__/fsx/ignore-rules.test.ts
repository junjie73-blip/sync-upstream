import {
  compileIgnorePattern,
  compileIgnorePatterns,
  IgnoreMatcher,
  parseIgnoreFile,
} from '../../src/fsx/ignore-rules'

function matcher(patterns: string[]): IgnoreMatcher {
  return new IgnoreMatcher(compileIgnorePatterns(patterns))
}

describe('compileIgnorePattern', () => {
  it('空行、注释与纯空白返回 null', () => {
    expect(compileIgnorePattern('')).toBeNull()
    expect(compileIgnorePattern('   ')).toBeNull()
    expect(compileIgnorePattern('# 说明')).toBeNull()
    expect(compileIgnorePattern('!')).toBeNull()
    expect(compileIgnorePattern('/')).toBeNull()
  })

  it('去掉尾部空格，转义空格按字面量保留', () => {
    expect(compileIgnorePattern('foo  ')?.regexp.source).toBe('^(?:[^/]+\\/)*foo$')
    expect(matcher(['foo\\ bar']).isIgnored('foo bar')).toBe(true)
  })

  it('含斜杠的模式锚定到根，不含斜杠的在任意层级匹配', () => {
    expect(compileIgnorePattern('/build')?.anchored).toBe(true)
    expect(compileIgnorePattern('build')?.anchored).toBe(false)
    expect(compileIgnorePattern('build')?.regexp.test('x/y/build')).toBe(true)
    expect(compileIgnorePattern('/build')?.regexp.test('x/y/build')).toBe(false)
  })

  it('尾部斜杠表示仅目录', () => {
    const rule = compileIgnorePattern('logs/')
    expect(rule?.dirOnly).toBe(true)
    expect(matcher(['logs/']).isIgnored('logs', true)).toBe(true)
    expect(matcher(['logs/']).isIgnored('logs/a.txt')).toBe(true)
    expect(matcher(['logs/']).isIgnored('logs.txt')).toBe(false)
  })

  it('base 让目录级 .gitignore 只约束自身子树', () => {
    const rule = compileIgnorePattern('*.md', { base: 'docs' })
    expect(rule?.regexp.test('docs/readme.md')).toBe(true)
    expect(rule?.regexp.test('docs/sub/readme.md')).toBe(true)
    expect(rule?.regexp.test('src/readme.md')).toBe(false)
  })

  it('保留原始 pattern / source 便于诊断', () => {
    const rule = compileIgnorePattern('  *.tmp  ', { source: '.syncignore' })
    expect(rule?.pattern).toBe('  *.tmp  ')
    expect(rule?.source).toBe('.syncignore')
  })

  it('通配符与字符集翻译正确', () => {
    expect(matcher(['?.log']).isIgnored('a.log')).toBe(true)
    expect(matcher(['?.log']).isIgnored('ab.log')).toBe(false)
    expect(matcher(['[ab].txt']).isIgnored('a.txt')).toBe(true)
    expect(matcher(['[ab].txt']).isIgnored('c.txt')).toBe(false)
    expect(matcher(['[!ab].txt']).isIgnored('c.txt')).toBe(true)
  })

  it('未闭合的方括号按字面量处理', () => {
    expect(matcher(['x[']).isIgnored('x[')).toBe(true)
    expect(matcher(['x[']).isIgnored('y')).toBe(false)
  })
})

describe('parseIgnoreFile', () => {
  it('按行解析并跳过注释与空行', () => {
    const rules = parseIgnoreFile('# c\n\nnode_modules/\n\ndist\n', { source: '.gitignore' })
    expect(rules.map(rule => rule.pattern)).toEqual(['node_modules/', 'dist'])
    expect(rules.every(rule => rule.source === '.gitignore')).toBe(true)
  })
})

describe('IgnoreMatcher', () => {
  it('最后的匹配规则获胜，! 可以反选', () => {
    const m = matcher(['*.log', '!keep.log'])
    expect(m.isIgnored('a.log')).toBe(true)
    expect(m.isIgnored('keep.log')).toBe(false)
  })

  it('被排除的目录之下无法反选', () => {
    const m = matcher(['secret/', '!secret/open.txt'])
    expect(m.isIgnored('secret/open.txt')).toBe(true)
    expect(m.ruleFor('secret/open.txt')?.pattern).toBe('secret/')
  })

  it('ruleFor 返回命中规则，null 表示保留', () => {
    const m = matcher(['vendor/'])
    expect(m.ruleFor('vendor/x')?.negated).toBe(false)
    expect(m.ruleFor('src/x')).toBeNull()
    expect(m.ruleFor('')).toBeNull()
  })

  it('反选规则不作为排除依据', () => {
    const m = matcher(['!only.txt'])
    expect(m.isIgnored('only.txt')).toBe(false)
    expect(m.ruleFor('only.txt')).toBeNull()
  })

  it('extend 追加规则且不改写原实例', () => {
    const base = matcher(['a/'])
    const wider = base.extend(compileIgnorePatterns(['b/']))
    expect(base.size).toBe(1)
    expect(wider.size).toBe(2)
    expect(wider.isIgnored('b/x')).toBe(true)
  })

  it('路径统一为 posix：反斜杠与多余分隔符都能匹配', () => {
    const m = matcher(['node_modules/'])
    expect(m.isIgnored('a\\node_modules\\b.js')).toBe(true)
    expect(m.isIgnored('src/', true)).toBe(false)
  })

  it('** 既能匹配任意层级也能匹配零层', () => {
    expect(matcher(['a/**/b']).isIgnored('a/b')).toBe(true)
    expect(matcher(['a/**/b']).isIgnored('a/x/y/b')).toBe(true)
    expect(matcher(['a/**']).isIgnored('a/x')).toBe(true)
    expect(matcher(['**/tmp/**']).isIgnored('q/w/tmp/e/f')).toBe(true)
  })
})
