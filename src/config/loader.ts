import type { RawSyncConfig, SyncConfig } from '../domain'
import type { ConfigFormat } from './parse'
import path from 'node:path'
import process from 'node:process'
import fs from 'fs-extra'
import { ConfigError, ValidationError } from '../errors'
import { CONFIG_FILE_NAMES, DEFAULT_CONFIG } from './defaults'
import { mergeConfigLayers } from './merge'
import { normalizeConfigKeys } from './normalize'
import { parseConfigContent, serializeConfig } from './parse'
import { resolveConfig } from './resolve'

export interface LoadedConfig {
  config: SyncConfig
  /**
   * The file's own layer with alias keys already rewritten onto canonical paths.
   * Validation happens once the CLI layer is merged in, so `-d a,b` can repair a
   * file that forgot `syncDirs` instead of being rejected before the CLI is read.
   */
  layer: RawSyncConfig
  /** Absolute path of the file that was read, or null when defaults were used. */
  source: string | null
  warnings: string[]
}

export async function discoverConfigFile(baseDir: string): Promise<string | null> {
  for (const name of CONFIG_FILE_NAMES) {
    const candidate = path.join(baseDir, name)
    if (await fs.pathExists(candidate))
      return candidate
  }
  return null
}

/**
 * Read one config file. Missing path, unreadable file and unparsable content are
 * three distinct failures: silently falling back to defaults is what made a typo'd
 * key look like "the tool ignored my config".
 */
export async function readConfigFile(filePath: string, cwd = process.cwd()): Promise<Record<string, unknown>> {
  const absolute = path.resolve(cwd, filePath)

  let exists: boolean
  try {
    exists = await fs.pathExists(absolute)
  }
  catch (error) {
    throw new ConfigError(`无法访问配置文件路径 ${absolute}`, error as Error, { cwd })
  }
  if (!exists) {
    throw new ConfigError(`配置文件不存在: ${absolute}`, undefined, { cwd })
  }

  let content: string
  try {
    content = await fs.readFile(absolute, 'utf8')
  }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    throw new ConfigError(
      code === 'EACCES' || code === 'EPERM'
        ? `没有读取配置文件的权限: ${absolute}`
        : `读取配置文件失败: ${absolute}`,
      error as Error,
      { code },
    )
  }

  if (content.trim() === '') {
    throw new ConfigError(`配置文件为空: ${absolute}`)
  }

  return parseConfigContent(content, path.basename(absolute))
}

export interface LoadConfigOptions {
  /** Explicit `--config` value; when absent the standard file names are searched. */
  configPath?: string
  baseDir?: string
}

/** Normalize one raw source into a canonical layer, turning alias type errors into hard failures. */
function buildLayer(raw: Record<string, unknown>): { layer: RawSyncConfig, config: SyncConfig, warnings: string[] } {
  const { value, warnings, errors } = normalizeConfigKeys(raw)
  if (errors.length > 0) {
    throw new ValidationError(`配置项类型错误:\n  - ${errors.join('\n  - ')}`)
  }
  return {
    layer: value,
    config: mergeConfigLayers<SyncConfig>(DEFAULT_CONFIG, value as Partial<SyncConfig>),
    warnings,
  }
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const baseDir = options.baseDir ?? process.cwd()
  const explicit = options.configPath?.trim()

  if (explicit) {
    const raw = await readConfigFile(explicit, baseDir)
    return { ...buildLayer(raw), source: path.resolve(baseDir, explicit) }
  }

  const found = await discoverConfigFile(baseDir)
  if (!found) {
    const built = buildLayer({})
    built.warnings.push(`未在 ${baseDir} 找到配置文件（已查找: ${CONFIG_FILE_NAMES.join(', ')}），使用默认值`)
    return { ...built, source: null }
  }

  return { ...buildLayer(await readConfigFile(found, baseDir)), source: found }
}

/**
 * Layer sources by precedence: later wins. Nested objects merge key by key, so a CLI
 * `--retry-delay` cannot wipe out the `retryConfig.maxRetries` from the config file.
 */
export function buildConfig(layers: Array<Record<string, unknown> | undefined>): ReturnType<typeof resolveConfig> {
  const merged = mergeConfigLayers<Record<string, unknown>>({}, ...layers.filter(Boolean) as Array<Record<string, unknown>>)
  return resolveConfig(merged)
}

export async function writeConfigFile(filePath: string, config: unknown, format: ConfigFormat = 'json'): Promise<string> {
  const absolute = path.resolve(filePath)
  const targetFormat: ConfigFormat = formatFromPathOrArg(absolute, format)
  await fs.ensureDir(path.dirname(absolute))
  await fs.writeFile(absolute, serializeConfig(config, targetFormat), 'utf8')
  return absolute
}

function formatFromPathOrArg(filePath: string, fallback: ConfigFormat): ConfigFormat {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.json5'))
    return 'json5'
  if (lower.endsWith('.yaml') || lower.endsWith('.yml'))
    return 'yaml'
  if (lower.endsWith('.toml'))
    return 'toml'
  return fallback
}

export async function generateDefaultConfig(filePath: string, format: ConfigFormat = 'json'): Promise<string> {
  return writeConfigFile(filePath, DEFAULT_CONFIG, format)
}

export async function saveConfig(config: Partial<SyncConfig>, format: ConfigFormat = 'json'): Promise<string> {
  return writeConfigFile(path.join(process.cwd(), `sync-upstream.config.${format}`), config, format)
}

export { CONFIG_FILE_NAMES, DEFAULT_CONFIG }
