import type { InitAnswers } from '../../src/commands/init'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import fs from 'fs-extra'
import { parseArgs } from '../../src/cli'
import { defaultInitAnswers, initConfig, initTarget, runInit } from '../../src/commands/init'
import { loadConfig } from '../../src/config'
import { ConflictResolutionStrategy } from '../../src/domain'
import { UserCancelError, ValidationError } from '../../src/errors'

let dir: string
let cwd: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-init-'))
  cwd = process.cwd()
  process.chdir(dir)
})

afterEach(async () => {
  process.chdir(cwd)
  await fs.remove(dir)
})

const ANSWERS: InitAnswers = {
  format: 'json',
  upstreamRepo: 'https://github.com/org/upstream.git',
  syncDirs: ['src/utils', 'docs'],
  upstreamBranch: 'main',
  companyBranch: 'company/main',
  commitMessage: 'chore: sync upstream',
  autoPush: false,
  deletePolicy: 'keep',
  conflictStrategy: ConflictResolutionStrategy.USE_SOURCE,
}

function askWith(answers: Partial<InitAnswers>): () => Promise<InitAnswers> {
  return async () => ({ ...defaultInitAnswers({ cwd: dir }), ...answers })
}

describe('init 的目标文件', () => {
  it('默认按格式取文件名，--config 覆盖一切', () => {
    expect(initTarget({ cwd: dir })).toBe(path.resolve(dir, 'sync-upstream.config.json'))
    expect(initTarget({ cwd: dir, format: 'yaml' })).toBe(path.resolve(dir, 'sync-upstream.config.yaml'))
    expect(initTarget({ cwd: dir, configPath: 'config/sync.json5', format: 'yaml' }))
      .toBe(path.resolve(dir, 'config/sync.json5'))
  })

  it('生成的内容只写回答过的字段', () => {
    const config = initConfig(ANSWERS)
    expect(Object.keys(config).sort()).toEqual([
      'autoPush',
      'commitMessage',
      'companyBranch',
      'conflictResolutionConfig',
      'deletePolicy',
      'syncDirs',
      'upstreamBranch',
      'upstreamRepo',
    ])
    expect(config.syncDirs).toEqual(['src/utils', 'docs'])
  })

  it('前后空格会被去掉，空目录项不会留下', () => {
    const config = initConfig({ ...ANSWERS, upstreamRepo: '  https://x/y.git  ', syncDirs: [' src/a ', '', '  '] })
    expect(config.upstreamRepo).toBe('https://x/y.git')
    expect(config.syncDirs).toEqual(['src/a'])
  })
})

describe('runInit 写盘', () => {
  it('问答结果落成一份下一跑就能加载的配置', async () => {
    const result = await runInit({ cwd: dir }, askWith(ANSWERS))
    expect(result.path).toBe(path.resolve(dir, 'sync-upstream.config.json'))
    expect(await fs.pathExists(result.path)).toBe(true)

    const written = await fs.readJson(result.path)
    expect(written.upstreamRepo).toBe(ANSWERS.upstreamRepo)
    expect(written.syncDirs).toEqual(ANSWERS.syncDirs)

    const loaded = await loadConfig({ baseDir: dir })
    expect(loaded.layer.upstreamRepo).toBe(ANSWERS.upstreamRepo)
    expect(loaded.layer.deletePolicy).toBe('keep')
    // 合并后的完整配置带着所有默认值，说明这份文件确实能通过校验。
    expect(result.config.conflictResolutionConfig.defaultStrategy).toBe(ConflictResolutionStrategy.USE_SOURCE)
    expect(result.config.retryConfig.maxRetries).toBeGreaterThan(0)
  })

  it('--config-format 决定扩展名与写出格式', async () => {
    const result = await runInit({ cwd: dir, format: 'yaml' }, askWith({ ...ANSWERS, format: 'yaml' }))
    expect(result.path).toBe(path.resolve(dir, 'sync-upstream.config.yaml'))
    expect(await fs.readFile(result.path, 'utf8')).toContain('upstreamRepo:')
  })

  it('文件已存在时拒绝覆盖，除非 --force', async () => {
    const { t } = await import('../../src/i18n')
    await fs.writeFile(path.resolve(dir, 'sync-upstream.config.json'), '{"keepme":true}\n', 'utf8')
    await expect(runInit({ cwd: dir }, askWith(ANSWERS))).rejects.toThrow(t('cli.initExists', { path: path.resolve(dir, 'sync-upstream.config.json') }))
    expect(await fs.readFile(path.resolve(dir, 'sync-upstream.config.json'), 'utf8')).toContain('keepme')

    await runInit({ cwd: dir, force: true }, askWith(ANSWERS))
    expect(await fs.readFile(path.resolve(dir, 'sync-upstream.config.json'), 'utf8')).toContain('upstreamRepo')
  })

  it('答案不合法时不落盘：宁可不写，也不写一个下一跑就报错的文件', async () => {
    const target = path.resolve(dir, 'sync-upstream.config.json')
    await expect(runInit({ cwd: dir }, askWith({ ...ANSWERS, deletePolicy: 'sometimes' as never })))
      .rejects
      .toThrow(ValidationError)
    expect(await fs.pathExists(target)).toBe(false)
  })

  it('取消问答时按取消处理，不留下半个文件', async () => {
    const target = path.resolve(dir, 'sync-upstream.config.json')
    await expect(runInit({ cwd: dir }, async () => {
      throw new UserCancelError('用户取消了操作')
    })).rejects.toThrow(UserCancelError)
    expect(await fs.pathExists(target)).toBe(false)
  })

  it('CLI 的 --config / -F 会一路传到 init', () => {
    const args = parseArgs(['init', '-C', 'nested/sync.toml', '-F', 'toml'])
    expect(initTarget({ cwd: dir, configPath: String(args.config), format: args['config-format'] as never, force: Boolean(args.force) }))
      .toBe(path.resolve(dir, 'nested/sync.toml'))
  })
})

describe('init 的问答（不依赖终端的部分）', () => {
  it('默认答案就是工具一直使用的取值', () => {
    expect(defaultInitAnswers({ cwd: dir })).toEqual({
      format: 'json',
      upstreamRepo: '',
      syncDirs: [],
      upstreamBranch: 'main',
      companyBranch: 'main',
      commitMessage: 'Sync upstream changes to specified directories',
      autoPush: false,
      deletePolicy: 'mirror',
      conflictStrategy: ConflictResolutionStrategy.PROMPT_USER,
    })
  })

  it('--json 与 -y 下拒绝问答，CI 不该卡在没人回答的问题上', async () => {
    const { t } = await import('../../src/i18n')
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const error = jest.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      expect(await runInitCommandWith(['init', '--json'])).toBe(2)
      expect(await runInitCommandWith(['init', '-y'])).toBe(2)
      // 断言取自目录本身，而不是某一种语言的原文：本机 LANG 是什么都不该让这条测试变红。
      expect(String(error.mock.calls.join(' '))).toContain(t('cli.initNeedsTerminal'))
    }
    finally {
      write.mockRestore()
      error.mockRestore()
    }
  })
})

async function runInitCommandWith(argv: string[]): Promise<number> {
  const { main } = await import('../../src/cli')
  return main(argv)
}
