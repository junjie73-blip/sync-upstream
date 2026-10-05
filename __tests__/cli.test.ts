import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import fs from 'fs-extra'
import {
  cliLayer,
  main,
  parseArgs,
  reportFatal,
  resolveRuntimeConfig,
  unknownFlags,
} from '../src/cli'
import { ConfigError, ValidationError } from '../src/errors'

const VALID = {
  upstreamRepo: 'https://example.com/upstream.git',
  upstreamBranch: 'main',
  companyBranch: 'company',
  syncDirs: ['src/config'],
}

let tmpDir: string
let previousCwd: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-cli-'))
  previousCwd = process.cwd()
  process.chdir(tmpDir)
})

afterEach(async () => {
  process.chdir(previousCwd)
  await fs.remove(tmpDir).catch(() => undefined)
})

async function configFile(name: string, raw: Record<string, unknown>): Promise<string> {
  const filePath = path.join(tmpDir, name)
  await fs.writeJson(filePath, raw)
  return filePath
}

describe('parseArgs', () => {
  it('短参数与长参数等价，字符串参数保留原值', () => {
    const short = parseArgs(['-r', 'https://example.com/u.git', '-b', 'dev', '-d', 'src/a,src/b'])
    const long = parseArgs(['--repo', 'https://example.com/u.git', '--branch', 'dev', '--dirs', 'src/a,src/b'])
    expect(long.repo).toBe(short.repo)
    expect(long.branch).toBe(short.branch)
    expect(long.dirs).toBe(short.dirs)
  })

  it('布尔开关默认 false，数字型参数按字符串读入后由 cliLayer 转换', () => {
    const args = parseArgs(['--push', '--preview-only', '--concurrency', '3'])
    expect(args.push).toBe(true)
    expect(args['preview-only']).toBe(true)
    expect(args.force).toBe(false)
    expect(args.concurrency).toBe('3')
  })

  it('给出默认值的开关不会凭空出现在参数表里', () => {
    expect(parseArgs([])['config-format']).toBe('json')
    expect(parseArgs([]).repo).toBeUndefined()
  })
})

describe('unknownFlags', () => {
  it('拼错的参数被识别出来，而不是被静默忽略', () => {
    const args = parseArgs(['--repo', 'x', '--prewiew-only'])
    expect(unknownFlags(args)).toEqual(['prewiew-only'])
  })

  it('已知参数与别名都不报错', () => {
    const args = parseArgs(['-r', 'x', '--verbose', '--gray-release', '--webhook-port', '9000'])
    expect(unknownFlags(args)).toEqual([])
  })
})

describe('cliLayer', () => {
  it('只写入用户真正给出的键，避免把默认值当成显式覆盖', () => {
    expect(cliLayer(parseArgs([]))).toEqual({})
    expect(cliLayer(parseArgs(['-r', '', '--push']))).toEqual({ autoPush: true })
  })

  it('逗号分隔列表与数值参数正确转换', () => {
    const layer = cliLayer(parseArgs([
      '-d',
      'src/a, src/b',
      '--ignore',
      'a.tmp,b.tmp',
      '--include-types',
      '.ts,.vue',
      '--concurrency',
      '8',
    ]))
    expect(layer.syncDirs).toEqual(['src/a', 'src/b'])
    expect(layer.ignorePatterns).toEqual(['a.tmp', 'b.tmp'])
    expect(layer.includeFileTypes).toEqual(['.ts', '.vue'])
    expect(layer.concurrencyLimit).toBe(8)
  })

  it('--force 强制覆盖，--incremental 与缺省都表示不强制覆盖', () => {
    expect(cliLayer(parseArgs(['--force'])).forceOverwrite).toBe(true)
    expect(cliLayer(parseArgs(['--incremental'])).forceOverwrite).toBe(false)
    expect(cliLayer(parseArgs([])).forceOverwrite).toBeUndefined()
  })

  it('重试参数分别落在 retryConfig 上', () => {
    const layer = cliLayer(parseArgs(['--retry-max', '5', '--retry-delay', '100', '--retry-backoff', '2']))
    expect(layer.retryConfig).toEqual({ maxRetries: 5, initialDelay: 100, backoffFactor: 2 })
  })

  it('灰度参数组装成 grayReleaseConfig，未给百分比时用默认 20', () => {
    const layer = cliLayer(parseArgs(['--gray-release', '--strategy', 'directory', '--canary-dirs', 'src/a']))
    expect(layer.grayReleaseConfig).toEqual({
      enable: true,
      strategy: 'directory',
      percentage: 20,
      canaryDirs: ['src/a'],
      filePatterns: undefined,
      validationScript: undefined,
    })
  })

  it('webhook 与认证参数各归其位', () => {
    const webhook = cliLayer(parseArgs(['--webhook-enable', '--webhook-port', '4321', '--webhook-secret', 's3cr3t']))
    expect(webhook.webhookConfig).toMatchObject({ enable: true, port: 4321, secret: 's3cr3t' })

    const auth = cliLayer(parseArgs(['--auth-type', 'ssh', '--auth-key', '/tmp/id_rsa']))
    expect(auth.authConfig).toMatchObject({ type: 'ssh', privateKeyPath: '/tmp/id_rsa' })
  })

  it('冲突策略落在 conflictResolutionConfig 上，且不产生未知键', () => {
    const args = parseArgs(['--conflict-strategy', 'use-source'])
    expect(unknownFlags(args)).toEqual([])
    expect(cliLayer(args)).toEqual({ conflictResolutionConfig: { defaultStrategy: 'use-source' } })
  })
})

describe('resolveRuntimeConfig', () => {
  it('CLI 覆盖配置文件，配置文件覆盖默认值', async () => {
    const file = await configFile('sync-upstream.config.json', { ...VALID, companyBranch: 'from-file' })
    const { config } = await resolveRuntimeConfig(parseArgs(['-C', file, '-c', 'from-cli']))

    expect(config.companyBranch).toBe('from-cli')
    expect(config.upstreamRepo).toBe(VALID.upstreamRepo)
    expect(config.concurrencyLimit).toBe(10)
  })

  it('嵌套参数只覆盖给出的那一项，其余保留文件里的设置', async () => {
    const file = await configFile('sync-upstream.config.json', { ...VALID, retryConfig: { maxRetries: 7 } })
    const { config } = await resolveRuntimeConfig(parseArgs(['-C', file, '--retry-delay', '50']))

    expect(config.retryConfig.maxRetries).toBe(7)
    expect(config.retryConfig.initialDelay).toBe(50)
  })

  it('指定了配置文件却不存在时直接报错（问题①）', async () => {
    await expect(resolveRuntimeConfig(parseArgs(['-C', 'missing.json'])))
      .rejects
      .toBeInstanceOf(ConfigError)
  })

  it('信息不全时一次性列出所有缺失项（问题①）', async () => {
    const file = await configFile('bad.json', { dirs: [''], maxParallelFiles: 'x', conflictStrategyValue: 1 })
    await expect(resolveRuntimeConfig(parseArgs(['-C', file]))).rejects.toThrow(ValidationError)
  })

  it('配置文件里的别名生效，并且不会把规范键报成未知项', async () => {
    const file = await configFile('alias.json', {
      repo: VALID.upstreamRepo,
      branch: 'dev',
      targetBranch: 'release',
      dirs: 'src/a,src/b',
      previewMode: true,
    })
    const { config, source } = await resolveRuntimeConfig(parseArgs(['-C', file]))

    expect(source).toBe(file)
    expect(config.upstreamRepo).toBe(VALID.upstreamRepo)
    expect(config.upstreamBranch).toBe('dev')
    expect(config.companyBranch).toBe('release')
    expect(config.syncDirs).toEqual(['src/a', 'src/b'])
    expect(config.previewOnly).toBe(true)
  })

  it('没有配置文件时使用默认值，仍能被 CLI 补全', async () => {
    const { config, source } = await resolveRuntimeConfig(parseArgs([
      '-r',
      VALID.upstreamRepo,
      '-d',
      'src/config',
      '-c',
      'company',
      '-y',
    ]))
    expect(source).toBeNull()
    expect(config.syncDirs).toEqual(['src/config'])
    expect(config.nonInteractive).toBe(true)
  })
})

describe('main', () => {
  it('--version 与 --help 直接返回 0', async () => {
    expect(await main(['--version'])).toBe(0)
    expect(await main(['-h'])).toBe(0)
  })

  it('未知参数返回退出码 2 并提示 --help', async () => {
    expect(await main(['--no-such-flag'])).toBe(2)
  })

  it('--generate-config 写出可用的默认配置文件', async () => {
    expect(await main(['--generate-config', '-F', 'yaml'])).toBe(0)

    const written = path.join(tmpDir, 'sync-upstream.config.yaml')
    expect(await fs.pathExists(written)).toBe(true)
    const { config } = await resolveRuntimeConfig(parseArgs(['-C', written, '-r', VALID.upstreamRepo, '-d', 'src/a']))
    expect(config.upstreamRepo).toBe(VALID.upstreamRepo)
  })

  it('--generate-config -C 指定路径时按路径写入', async () => {
    expect(await main(['--generate-config', '-C', 'nested/my.json5'])).toBe(0)
    expect(await fs.pathExists(path.join(tmpDir, 'nested', 'my.json5'))).toBe(true)
  })

  it('reportFatal 按错误类别给出退出码', () => {
    expect(reportFatal(new ValidationError('bad'))).toBe(2)
    expect(reportFatal(new ConfigError('bad'))).toBe(2)
    expect(reportFatal(new Error('boom'))).toBe(1)
  })
})
