import type { CompletionSource } from '../src/completion'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import fs from 'fs-extra'
import { completionSource, main, runCompletion } from '../src/cli'
import { COMPLETION_SHELLS, completionScript, isCompletionShell } from '../src/completion'

function source(overrides: Partial<CompletionSource> = {}): CompletionSource {
  return {
    stringFlags: ['repo', 'branch', 'config'],
    booleanFlags: ['push', 'force'],
    negatableFlags: ['delete', 'no-delete'],
    aliases: { r: 'repo', b: 'branch', p: 'push' },
    subcommands: ['status', 'why'],
    verbs: ['init', 'completion'],
    descriptions: { status: '概览', why: '解释某个文件', init: '生成配置', completion: '输出补全' },
    ...overrides,
  }
}

afterEach(() => {
  jest.restoreAllMocks()
})

describe('补全脚本的内容', () => {
  it('只认得 bash / zsh / fish', () => {
    expect(COMPLETION_SHELLS).toEqual(['bash', 'zsh', 'fish'])
    expect(isCompletionShell('zsh')).toBe(true)
    expect(isCompletionShell('powershell')).toBe(false)
  })

  it('三种脚本都覆盖同一批参数，含短选项与 --no- 形式', () => {
    const longs = ['repo', 'branch', 'config', 'push', 'force', 'delete', 'no-delete']
    for (const shell of COMPLETION_SHELLS) {
      const script = completionScript(shell, source())
      // fish 用 `-l repo` / `-s r`，bash 与 zsh 用 `--repo` / `-r`。
      for (const long of longs)
        expect(script).toContain(shell === 'fish' ? `-l ${long}` : `--${long}`)
      for (const short of ['r', 'b', 'p'])
        expect(script).toContain(shell === 'fish' ? `-s ${short}` : `-${short}`)
    }
  })

  it('取值型选项在 fish 里标注为还要接参数，开关则不标', () => {
    const fish = completionScript('fish', source())
    // fish 的 `-r` 就是"这个选项需要一个取值"。
    expect(fish).toContain('complete -c sync-upstream -l repo -s r -r')
    expect(fish).not.toMatch(/-l push.*-r/)
  })

  it('zsh 以 #compdef 开头并给子命令带上说明', () => {
    const zsh = completionScript('zsh', source())
    expect(zsh).toContain('#compdef sync-upstream')
    expect(zsh).toContain('\'why:解释某个文件\'')
    expect(zsh).toContain('\'completion:输出补全\'')
  })

  it('头注释告诉运维怎么重新生成', () => {
    for (const shell of COMPLETION_SHELLS)
      expect(completionScript(shell, source())).toContain(`sync-upstream completion ${shell}`)
  })

  it('用真实的 CLI 参数表生成时，每个已声明的开关都在脚本里', () => {
    const real = completionSource()
    expect(real.subcommands).toEqual(['status', 'why', 'doctor', 'history'])
    expect(real.verbs).toEqual(['init', 'completion'])
    for (const shell of COMPLETION_SHELLS) {
      const script = completionScript(shell, real)
      // fish 写 `-l repo`，bash / zsh 写 `--repo`。
      const token = (flag: string): string => shell === 'fish' ? `-l ${flag}` : `--${flag}`
      for (const flag of [...real.stringFlags, ...real.booleanFlags, ...real.negatableFlags])
        expect(script).toContain(token(flag))
      for (const long of Object.values(real.aliases))
        expect(script).toContain(token(long))
    }
  })
})

describe('bash 补全真的能跑', () => {
  const file = path.join(os.tmpdir(), `sync-completion-${process.pid}.bash`)

  beforeAll(() => {
    fs.writeFileSync(file, completionScript('bash', completionSource()), 'utf8')
  })

  afterAll(() => {
    fs.removeSync(file)
  })

  /** 直接调用生成的函数，绕开 `complete` 注册，检查它算出来的 COMPREPLY。 */
  function complete(words: string[], index = words.length - 1): string[] {
    const script = `
      source '${file.replace(/\\/g, '/')}'
      COMP_WORDS=(${words.map(word => `"${word}"`).join(' ')})
      COMP_CWORD=${index}
      _sync_upstream
      printf '%s\\n' "\${COMPREPLY[@]}"
    `
    return execFileSync('bash', ['-c', script], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .sort()
  }

  it('第一个位置补子命令', () => {
    const got = complete(['sync-upstream', ''])
    for (const verb of ['status', 'why', 'doctor', 'history', 'init', 'completion'])
      expect(got).toContain(verb)
  })

  it('敲了连字符就补参数', () => {
    expect(complete(['sync-upstream', '--lan'])).toEqual(['--lang'])
  })

  it('选项后面接的是取值，不再推荐下一个开关', () => {
    expect(complete(['sync-upstream', '--repo', ''])).toEqual([])
    expect(complete(['sync-upstream', '--config', ''])).toEqual([])
  })

  it('上游 URL 不会被当成子命令', () => {
    // 认错子命令的话，空位置只会补参数；补得出 status 才说明 -r 的取值被正确跳过。
    expect(complete(['sync-upstream', '-r', 'https://x/y.git', ''])).toContain('status')
    expect(complete(['sync-upstream', '-r', 'https://x/y.git', '--del']))
      .toEqual(['--delete', '--delete-policy'].sort())
  })

  it('已经给出子命令后仍然继续补参数', () => {
    expect(complete(['sync-upstream', 'status', '--js'])).toEqual(['--json'])
  })

  it('completion 之后只补 shell 名', () => {
    expect(complete(['sync-upstream', 'completion', 'zs'])).toEqual(['zsh'])
  })
})

describe('completion 子命令的边界', () => {
  it('不认识的 shell 返回退出码 2 并给出用法', () => {
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
    expect(runCompletion(['powershell'])).toBe(2)
    expect(String(write.mock.calls.join(' '))).toContain('completion <bash|zsh|fish>')
  })

  it('缺参数时同样报 2，而不是打印半截脚本', () => {
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
    expect(runCompletion([])).toBe(2)
    expect(write).not.toHaveBeenCalledWith(expect.stringContaining('_sync_upstream'))
  })

  it('main 里 completion 在读取配置之前就被处理', async () => {
    // 这个目录里没有 sync-upstream.config.json：能返回 0 就说明没有走配置加载。
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-completion-cli-'))
    const cwd = process.cwd()
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      process.chdir(dir)
      expect(await main(['completion', 'fish'])).toBe(0)
      expect(String(write.mock.calls.join(' '))).toContain('complete -c sync-upstream')
    }
    finally {
      write.mockRestore()
      process.chdir(cwd)
      await fs.remove(dir)
    }
  })
})
