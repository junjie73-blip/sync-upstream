import process from 'node:process'
import { parseArgs } from '../src/cli'
import { helpText } from '../src/help'
import {
  currentLocale,
  detectLocale,
  initLocale,
  isLocale,
  joinList,
  messageKeys,
  setLocale,
  t,
} from '../src/i18n'
import { en, zh } from '../src/i18n/catalog'

/**
 * `zh` is the source of truth and must keep printing exactly what the tool always printed, while
 * `en` has to keep pace key for key — a message added in Chinese only would silently hand an
 * English user a Chinese error.
 */
afterEach(() => {
  setLocale('zh')
})

describe('语言判定', () => {
  it('SYNC_UPSTREAM_LANG 只影响本工具，优先级最高', () => {
    expect(detectLocale({ SYNC_UPSTREAM_LANG: 'en', LANG: 'zh_CN.UTF-8' })).toBe('en')
    expect(detectLocale({ SYNC_UPSTREAM_LANG: 'zh', LANG: 'en_US.UTF-8' })).toBe('zh')
  })

  it('LC_ALL 压过 LANG，LANG 压过 LANGUAGE', () => {
    expect(detectLocale({ LC_ALL: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' })).toBe('zh')
    expect(detectLocale({ LANG: 'en_US.UTF-8', LANGUAGE: 'zh_CN:en' })).toBe('en')
  })

  it('LANGUAGE 是冒号列表，第一项才是用户读的语言', () => {
    expect(detectLocale({ LANGUAGE: 'zh_CN:en_US' })).toBe('zh')
  })

  it('C / POSIX 不算语言信号，继续看下一项', () => {
    expect(detectLocale({ LC_ALL: 'C', LANG: 'ja_JP.UTF-8' })).toBe('en')
    expect(detectLocale({ LC_ALL: 'C', LANG: 'POSIX' })).toBe('zh')
  })

  it('带编码后缀的 C.UTF-8 同样不算信号（容器与 CI 的默认值）', () => {
    expect(detectLocale({ LC_ALL: 'C.UTF-8' })).toBe('zh')
    expect(detectLocale({ LANG: 'C.UTF-8' })).toBe('zh')
    expect(detectLocale({ LC_ALL: 'C.UTF-8', LANG: 'en_US.UTF-8' })).toBe('en')
    expect(detectLocale({ LC_ALL: 'POSIX.UTF-8', LANG: 'zh_CN.GBK' })).toBe('zh')
  })

  it('非中文的区域设置一律给英文，什么都没给则保持中文', () => {
    expect(detectLocale({ LANG: 'de_DE.UTF-8' })).toBe('en')
    expect(detectLocale({})).toBe('zh')
    expect(detectLocale({ LANG: 'zh' })).toBe('zh')
  })

  it('只认得 zh 与 en，别的值不算', () => {
    expect(isLocale('zh')).toBe(true)
    expect(isLocale('EN')).toBe(true)
    expect(isLocale('fr')).toBe(false)
    expect(isLocale('zh_CN.UTF-8')).toBe(false)
  })

  it('--lang 优先于环境变量，写错时保留原语言', () => {
    const env = { LANG: 'en_US.UTF-8' }
    expect(initLocale('zh', env)).toBe('zh')
    expect(initLocale(undefined, env)).toBe('en')
    expect(initLocale('klingon', env)).toBe('en')
    expect(setLocale('klingon')).toBe('en')
    expect(currentLocale()).toBe('en')
  })

  it('--lang 是给 i18n 的，不进配置', () => {
    expect(parseArgs(['--lang', 'en']).lang).toBe('en')
    // 没给时 minimist 不会造一个空串出来，`undefined` 才是"跟随环境"。
    expect(parseArgs([]).lang).toBeUndefined()
  })
})

describe('消息取值', () => {
  it('未知 key 原样返回，测试失败时比空字符串响', () => {
    expect(t('v.definitelyNotAKey')).toBe('v.definitelyNotAKey')
  })

  it('只替换调用方给过的占位符，文档里的 {target} 不被吃掉', () => {
    expect(t('v.required', { field: 'syncDirs' })).toBe('syncDirs 不能为空')
    expect(t('v.prBranchPattern')).toContain('{target}')
    expect(t('v.prBranchPattern')).toContain('{date}')
    expect(t('v.notifyUrlHttp', { field: 'notifyConfig.url', value: 'ftp://x' })).toContain('ftp://x')
  })

  it('插入值里的 {..} 不会被二次解析', () => {
    expect(t('e.originalError', { message: 'bad { thing }' })).toBe('原始错误: bad { thing }')
  })

  it('列表分隔符跟着语言走', () => {
    setLocale('zh')
    expect(joinList(['a', 'b'])).toBe('a、b')
    expect(joinList(['a', 'b'], 'semicolon')).toBe('a；b')
    expect(joinList([])).toBe('')
    setLocale('en')
    expect(joinList(['a', 'b'])).toBe('a, b')
    expect(joinList(['a', 'b'], 'semicolon')).toBe('a; b')
  })

  it('英文目录与中文目录键集合完全一致', () => {
    const zhKeys = messageKeys().sort()
    const enKeys = Object.keys(en).sort()
    expect(enKeys).toEqual(zhKeys)
  })

  it('每条消息都真的能取到，且模板里的中文只剩一条不该有的空串', () => {
    for (const key of messageKeys()) {
      expect(typeof zh[key]).toBe('string')
      expect(zh[key].length).toBeGreaterThan(0)
      expect(en[key].length).toBeGreaterThan(0)
    }
  })
})

describe('帮助文本的中英对照', () => {
  it('两种语言列出同一批参数', () => {
    const flagsOf = (text: string): string[] => [...text.matchAll(/--[a-z][a-z0-9-]*/g)].map(item => item[0]).sort()
    const zhFlags = new Set(flagsOf(helpText('zh')))
    const enFlags = new Set(flagsOf(helpText('en')))
    expect([...enFlags].sort()).toEqual([...zhFlags].sort())
    // 新加的语言开关必须真的出现在帮助里，否则等于没有文档。
    for (const flag of ['--lang', '--json', '--fetch-filter', '--log-file', '--webhook-queue', '--pr-no-create'])
      expect(zhFlags.has(flag)).toBe(true)
  })

  it('两种语言都列出子命令与 init/completion', () => {
    for (const locale of ['zh', 'en'] as const) {
      const text = helpText(locale)
      for (const verb of ['status', 'why', 'doctor', 'history', 'init', 'completion'])
        expect(text).toContain(`sync-upstream ${verb}`)
    }
  })

  it('帮助随当前语言输出', () => {
    setLocale('en')
    expect(helpText()).toContain('Usage:')
    setLocale('zh')
    expect(helpText()).toContain('用法:')
  })

  it('子命令一览按当前语言取用', async () => {
    const { SUBCOMMAND_HELP } = await import('../src/commands')
    setLocale('zh')
    expect(SUBCOMMAND_HELP.find(item => item.name === 'why')?.usage).toBe('sync-upstream why <文件路径>')
    setLocale('en')
    expect(SUBCOMMAND_HELP.find(item => item.name === 'why')?.usage).toBe('sync-upstream why <path>')
    expect(SUBCOMMAND_HELP.find(item => item.name === 'doctor')?.description).toContain('environment')
  })
})

describe('错误消息的语言', () => {
  it('describe() 与 formatUnknownError 跟随当前语言', async () => {
    const { ConfigError, formatUnknownError } = await import('../src/errors')
    // 颜色码会插在文案中间，比较前先抹掉。
    // eslint-disable-next-line no-control-regex
    const plain = (text: string): string => text.replace(/\u001B\[\d+m/g, '')
    setLocale('en')
    const error = new ConfigError('boom', new Error('git died'))
    expect(error.describe()).toContain('Underlying error: git died')
    expect(plain(formatUnknownError(new Error('nope')))).toBe('Unexpected error: nope')
    setLocale('zh')
    expect(plain(formatUnknownError(new Error('nope')))).toBe('未预期的错误: nope')
    expect(new ConfigError('boom', new Error('git died')).describe()).toContain('原始错误: git died')
  })

  it('UserCancelError 的默认文案跟着语言走', async () => {
    const { UserCancelError } = await import('../src/errors')
    setLocale('en')
    expect(new UserCancelError().message).toBe('The operation was cancelled')
    setLocale('zh')
    expect(new UserCancelError().message).toBe('用户取消了操作')
  })

  it('--lang 通过 CLI 生效：帮助与参数错误都用英文', async () => {
    const { applyLocale } = await import('../src/cli')
    const env = { ...process.env }
    try {
      process.env.LC_ALL = 'en_US.UTF-8'
      expect(applyLocale(parseArgs([]))).toBeUndefined()
      expect(currentLocale()).toBe('en')
      expect(applyLocale(parseArgs(['--lang', 'zh']))).toBeUndefined()
      expect(currentLocale()).toBe('zh')
      // 写错的 --lang 用"当前语言"解释一句就退场，不会顺手改掉语言。
      expect(applyLocale(parseArgs(['--lang', 'klingon'])))
        .toBe('--lang 只能是 zh 或 en，实际是 klingon')
      expect(currentLocale()).toBe('zh')
      setLocale('en')
      expect(applyLocale(parseArgs(['--lang', 'klingon'])))
        .toBe('--lang must be zh or en, got klingon')
      expect(currentLocale()).toBe('en')
      // 空值等于没给，跟着环境走。
      expect(applyLocale(parseArgs(['--lang', '']))).toBeUndefined()
      expect(currentLocale()).toBe('en')
    }
    finally {
      for (const name of ['LC_ALL', 'LANG', 'LANGUAGE', 'SYNC_UPSTREAM_LANG'] as const) {
        if (env[name] === undefined)
          delete process.env[name]
        else process.env[name] = env[name]
      }
      setLocale('zh')
    }
  })

  it('配置校验失败在英文环境下也是英文', async () => {
    const { resolveConfig } = await import('../src/config/resolve')
    setLocale('en')
    try {
      expect(() => resolveConfig({ upstreamRepo: '', syncDirs: [] })).toThrow(/must not be empty/)
    }
    finally {
      setLocale('zh')
    }
  })
})
