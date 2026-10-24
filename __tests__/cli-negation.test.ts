import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import fs from 'fs-extra'
import { cliLayer, main, parseArgs, reportFatal, unknownFlags } from '../src/cli'
import { helpText } from '../src/help'
import { setLocale, t } from '../src/i18n'

/**
 * minimist 会把 `--no-x` 一律折叠成 `x: false`，所以真正会出问题的地方不是解析，而是
 * "这个键算不算已知参数"：`pr`、`fetch-tags`、`delete`、`renames` 都不在声明过的布尔参数里，
 * 没有 NEGATABLE_FLAGS 兜住时，`--no-pr` 就变成了 "无法识别的命令行参数: pr"。
 * 而 `--help` 一直在宣传这些否定写法——被参数检查退回退出码 2 就是食言。
 */
afterEach(() => {
  setLocale('zh')
})

describe('--no- 形式的开关', () => {
  it('--no-fetch-tags 是已知参数，并关闭标签抓取', () => {
    const args = parseArgs(['--no-fetch-tags'])
    expect(unknownFlags(args)).toEqual([])
    expect(cliLayer(args).fetchConfig).toEqual(expect.objectContaining({ tags: false }))
  })

  it('--fetch-tags 反过来打开', () => {
    const args = parseArgs(['--fetch-tags'])
    expect(unknownFlags(args)).toEqual([])
    expect(cliLayer(args).fetchConfig).toEqual(expect.objectContaining({ tags: true }))
  })

  it('--no-pr 关掉配置里开启的 PR 模式', () => {
    const args = parseArgs(['--no-pr'])
    expect(unknownFlags(args)).toEqual([])
    expect(cliLayer(args).prConfig).toEqual({ enable: false })
  })

  it('两者都不给时不写入，配置文件说了算', () => {
    expect(cliLayer(parseArgs([])).fetchConfig).toBeUndefined()
    expect(cliLayer(parseArgs([])).prConfig).toBeUndefined()
  })

  it('--lang 同样是已知参数', () => {
    expect(unknownFlags(parseArgs(['--lang', 'en']))).toEqual([])
  })

  it('帮助里承诺过的否定写法，主流程不会当成未知参数', async () => {
    // 临时目录里既没有配置文件也不是 git 仓库，这一跑注定失败；要验证的是它失败在哪一步。
    // 参数被拒时会打印"无法识别的命令行参数"并直接返回 2；走到配置校验才说明否定写法被接受了。
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-negation-'))
    const cwd = process.cwd()
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const error = jest.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      process.chdir(dir)
      const code = await main(['--no-pr', '--no-fetch-tags', '--json', '-y'])
        .catch((failure: unknown) => reportFatal(failure))
      const haystack = `${String(write.mock.calls.join(' '))} ${String(error.mock.calls.join(' '))}`
      // 断言两头：既不能出现参数拒绝，也必须真的走到了配置校验。
      expect(haystack).toContain(t('v.summary'))
      expect(haystack).not.toContain(t('cli.unknownFlags').split(':')[0])
      expect(code).toBe(2)
    }
    finally {
      write.mockRestore()
      error.mockRestore()
      process.chdir(cwd)
      await fs.remove(dir)
    }
  })
})

describe('帮助与补全说的是同一批参数', () => {
  it('--lang / init / completion 都进了帮助文本', () => {
    for (const locale of ['zh', 'en'] as const) {
      const text = helpText(locale)
      expect(text).toContain('--lang')
      expect(text).toContain('init')
      expect(text).toContain('completion')
    }
  })
})
