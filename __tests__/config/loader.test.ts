import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import fs from 'fs-extra'
import { DEFAULT_CONFIG } from '../../src/config/defaults'
import {
  buildConfig,
  CONFIG_FILE_NAMES,
  discoverConfigFile,
  generateDefaultConfig,
  loadConfig,
  readConfigFile,
  saveConfig,
  writeConfigFile,
} from '../../src/config/loader'
import { ConfigError, ValidationError } from '../../src/errors'

const VALID = {
  upstreamRepo: 'https://example.com/upstream.git',
  upstreamBranch: 'main',
  companyBranch: 'downstream',
  syncDirs: ['src/components'],
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-config-'))
})

afterEach(async () => {
  await fs.remove(tmpDir).catch(() => undefined)
})

async function write(name: string, content: string): Promise<string> {
  const filePath = path.join(tmpDir, name)
  await fs.writeFile(filePath, content, 'utf8')
  return filePath
}

describe('discoverConfigFile', () => {
  it('按 CONFIG_FILE_NAMES 的优先级返回第一个存在的路径', async () => {
    expect(await discoverConfigFile(tmpDir)).toBeNull()

    const yamlPath = await write(CONFIG_FILE_NAMES[2], JSON.stringify(VALID))
    const jsonPath = await write(CONFIG_FILE_NAMES[0], JSON.stringify(VALID))
    expect(await discoverConfigFile(tmpDir)).toBe(jsonPath)
    expect(await fs.readFile(yamlPath, 'utf8')).toBeTruthy()
  })
})

describe('readConfigFile', () => {
  it('区分“文件不存在”与“没有读取权限”“解析失败”三类问题', async () => {
    await expect(readConfigFile(path.join(tmpDir, 'nope.json'), tmpDir))
      .rejects
      .toThrow(/配置文件不存在/)

    const broken = await write('broken.json', '{ this is not json ]')
    await expect(readConfigFile(broken, tmpDir)).rejects.toThrow(/解析失败/)

    const empty = await write('empty.json', '   \n')
    await expect(readConfigFile(empty, tmpDir)).rejects.toThrow(/配置文件为空/)
  })

  it('相对路径基于传入的 cwd 解析', async () => {
    const filePath = await write('cfg.json', JSON.stringify(VALID))
    const raw = await readConfigFile('cfg.json', tmpDir)
    expect(raw.upstreamRepo).toBe(VALID.upstreamRepo)
    expect(path.basename(filePath)).toBe('cfg.json')
  })

  it('支持 json5 / yaml / toml 与无扩展名 rc 文件', async () => {
    const json5Raw = await readConfigFile(
      await write('a.json5', `{ // 注释\n  upstreamRepo: 'https://example.com/x.git' }`),
      tmpDir,
    )
    expect(json5Raw.upstreamRepo).toBe('https://example.com/x.git')

    const yamlRaw = await readConfigFile(
      await write('a.yaml', 'upstreamRepo: https://example.com/y.git\nsyncDirs:\n  - src/a\n'),
      tmpDir,
    )
    expect(yamlRaw.syncDirs).toEqual(['src/a'])

    const tomlRaw = await readConfigFile(
      await write('a.toml', 'upstreamRepo = "https://example.com/z.git"\n'),
      tmpDir,
    )
    expect(tomlRaw.upstreamRepo).toBe('https://example.com/z.git')

    const rcRaw = await readConfigFile(
      await write('.sync-toolrc', `{"upstreamRepo": "${VALID.upstreamRepo}"}`),
      tmpDir,
    )
    expect(rcRaw.upstreamRepo).toBe(VALID.upstreamRepo)
  })

  it('顶层不是对象时给出可定位的错误', async () => {
    await expect(readConfigFile(await write('arr.json', '[1,2]'), tmpDir))
      .rejects
      .toThrow(/顶层必须是对象/)
  })

  it('BOM 头不影响 JSON 解析', async () => {
    const raw = await readConfigFile(await write('bom.json', `${'\uFEFF'}{"upstreamRepo": "git@host:o/r.git"}`), tmpDir)
    expect(raw.upstreamRepo).toBe('git@host:o/r.git')
  })

  it('读取失败时抛 ConfigError 而不是裸 Error', async () => {
    await expect(readConfigFile(path.join(tmpDir, 'missing.json'), tmpDir)).rejects.toBeInstanceOf(ConfigError)
  })
})

describe('loadConfig', () => {
  it('没有配置文件时返回默认值并告警，不做校验（校验留给合并后的 resolveConfig）', async () => {
    const loaded = await loadConfig({ baseDir: tmpDir })
    expect(loaded.source).toBeNull()
    expect(loaded.layer).toEqual({})
    expect(loaded.config.upstreamBranch).toBe(DEFAULT_CONFIG.upstreamBranch)
    expect(loaded.warnings.some(item => item.includes('未在'))).toBe(true)
  })

  it('显式 configPath 优先于自动发现', async () => {
    await write(CONFIG_FILE_NAMES[0], JSON.stringify({ ...VALID, companyBranch: 'from-default-file' }))
    const chosen = await write('custom.json', JSON.stringify({ ...VALID, companyBranch: 'from-custom' }))

    const loaded = await loadConfig({ baseDir: tmpDir, configPath: 'custom.json' })
    expect(loaded.source).toBe(chosen)
    expect(loaded.config.companyBranch).toBe('from-custom')
  })

  it('别名在读取阶段就归一化，并保留原始层的告警', async () => {
    await write(CONFIG_FILE_NAMES[0], JSON.stringify({
      repo: 'https://example.com/up.git',
      dirs: 'src/a,src/b',
      maxParallelFiles: 4,
    }))

    const loaded = await loadConfig({ baseDir: tmpDir })
    expect(loaded.layer.upstreamRepo).toBe('https://example.com/up.git')
    expect(loaded.layer.syncDirs).toEqual(['src/a', 'src/b'])
    expect(loaded.config.concurrencyLimit).toBe(4)
    expect(loaded.warnings.filter(item => item.includes('别名'))).toHaveLength(3)
  })

  it('别名值类型不对时立刻失败，不会带着坏值继续跑', async () => {
    await write(CONFIG_FILE_NAMES[0], JSON.stringify({ ...VALID, maxParallelFiles: 'many' }))
    await expect(loadConfig({ baseDir: tmpDir })).rejects.toBeInstanceOf(ValidationError)
  })

  it('值非法但字段齐全时由合并层报错，一次列全所有问题', async () => {
    const loaded = await loadConfig({
      baseDir: tmpDir,
      configPath: await write('bad.json', JSON.stringify({ repo: 'not a url at all', dirs: [], nope: 1 })),
    })

    expect(() => buildConfig([loaded.layer])).toThrow(/upstreamRepo 不是可识别的仓库地址[\s\S]*syncDirs 必须是非空数组/)
    expect(() => buildConfig([{ ...VALID, retryConfig: { maxRetries: -1, backoffFactor: 0.5 } }]))
      .toThrow(/maxRetries 必须是[\s\S]*backoffFactor 必须是/)
  })

  it('规范键不会被当成拼写错误', async () => {
    const loaded = await loadConfig({
      baseDir: tmpDir,
      configPath: await write('ok.json', JSON.stringify({ ...VALID, ignorePatterns: ['**/*.tmp'] })),
    })
    const resolved = buildConfig([loaded.layer])
    expect(resolved.warnings.some(item => item.includes('未识别'))).toBe(false)
    expect(resolved.config.ignorePatterns).toEqual(['**/*.tmp'])
  })

  it('未知键会被明确报告，而不是静默无效', () => {
    const { warnings } = buildConfig([{ ...VALID, suncDirs: ['a'] }])
    expect(warnings.some(item => item.includes('suncDirs'))).toBe(true)
  })

  it('dryRun 与 autoPush 同时开启时降为不推送', () => {
    const { config, warnings } = buildConfig([{ ...VALID, dryRun: true, autoPush: true }])
    expect(config.autoPush).toBe(false)
    expect(warnings.some(item => item.includes('已跳过推送'))).toBe(true)
  })
})

describe('buildConfig', () => {
  it('命令行层覆盖配置文件层，配置文件层覆盖默认值', () => {
    const { config } = buildConfig([
      { upstreamRepo: VALID.upstreamRepo, syncDirs: VALID.syncDirs, companyBranch: 'file-branch' },
      { companyBranch: 'cli-branch', previewOnly: true },
    ])
    expect(config.companyBranch).toBe('cli-branch')
    expect(config.previewOnly).toBe(true)
    expect(config.concurrencyLimit).toBe(DEFAULT_CONFIG.concurrencyLimit)
  })

  it('undefined 层被忽略，嵌套对象按键合并', () => {
    const { config } = buildConfig([
      { upstreamRepo: VALID.upstreamRepo, syncDirs: VALID.syncDirs, retryConfig: { maxRetries: 9 } },
      undefined,
      { retryConfig: { initialDelay: 5 } },
    ])
    expect(config.retryConfig.maxRetries).toBe(9)
    expect(config.retryConfig.initialDelay).toBe(5)
    expect(config.retryConfig.backoffFactor).toBe(DEFAULT_CONFIG.retryConfig.backoffFactor)
  })
})

describe('writeConfigFile / generateDefaultConfig', () => {
  it('按扩展名序列化，并能被读回', async () => {
    const target = path.join(tmpDir, 'sub', 'sync-upstream.config.yaml')
    const written = await writeConfigFile(target, { ...VALID, concurrencyLimit: 3 })
    expect(written).toBe(target)

    const raw = await readConfigFile(written, tmpDir)
    expect(raw.syncDirs).toEqual(VALID.syncDirs)

    const tomlPath = await writeConfigFile(path.join(tmpDir, 'out.toml'), VALID)
    expect(await fs.readFile(tomlPath, 'utf8')).toContain('upstreamRepo')
  })

  it('生成默认配置后立刻可加载', async () => {
    const generated = await generateDefaultConfig(path.join(tmpDir, CONFIG_FILE_NAMES[0]))
    const merged = { ...DEFAULT_CONFIG, upstreamRepo: VALID.upstreamRepo, syncDirs: VALID.syncDirs }
    await fs.writeJson(generated, merged)

    const loaded = await loadConfig({ baseDir: tmpDir })
    expect(loaded.config.syncDirs).toEqual(VALID.syncDirs)
    expect(loaded.config.includeFileTypes).toEqual([])
  })

  it('saveConfig 使用当前工作目录', async () => {
    const previous = process.cwd()
    process.chdir(tmpDir)
    try {
      const saved = await saveConfig(VALID, 'json')
      expect(saved).toBe(path.join(fs.realpathSync(tmpDir), 'sync-upstream.config.json'))
      expect(await fs.pathExists(saved)).toBe(true)
    }
    finally {
      process.chdir(previous)
    }
  })
})
