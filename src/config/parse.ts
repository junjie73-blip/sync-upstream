import tomlParser from '@iarna/toml'
import yaml from 'js-yaml'
import json5 from 'json5'
import { ConfigError } from '../errors'

export type ConfigFormat = 'json' | 'json5' | 'yaml' | 'toml'

const EXTENSION_FORMATS: Record<string, ConfigFormat> = {
  '.json': 'json',
  '.json5': 'json5',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
}

export function formatFromFileName(fileName: string): ConfigFormat | null {
  const lower = fileName.toLowerCase()
  for (const [ext, format] of Object.entries(EXTENSION_FORMATS)) {
    if (lower.endsWith(ext))
      return format
  }
  return null
}

const PARSERS: Record<ConfigFormat, (content: string) => unknown> = {
  json: content => JSON.parse(content),
  json5: content => json5.parse(content),
  yaml: content => yaml.load(content),
  toml: content => tomlParser.parse(content),
}

/**
 * Parse config text. Extension-less rc files are tried as JSON, then YAML, then TOML
 * so a mislabelled file still loads; a genuinely broken file reports every attempt.
 * A syntactically valid file of the wrong shape fails immediately — retrying it as
 * another format only produces a misleading "解析失败" for `[1,2]`.
 */
export function parseConfigContent(content: string, fileName: string): Record<string, unknown> {
  const explicit = formatFromFileName(fileName)
  const candidates: ConfigFormat[] = explicit ? [explicit] : ['json', 'yaml', 'toml']
  const failures: string[] = []

  for (const format of candidates) {
    let parsed: unknown
    try {
      parsed = PARSERS[format](stripBom(content))
    }
    catch (error) {
      failures.push(`${format}: ${(error as Error).message}`)
      continue
    }
    return assertPlainObject(parsed, fileName, format)
  }

  throw new ConfigError(
    `配置文件 ${fileName} 解析失败`,
    undefined,
    {
      fileName,
      triedFormats: candidates,
      failures,
    },
  )
}

function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content
}

function assertPlainObject(parsed: unknown, fileName: string, format: ConfigFormat): Record<string, unknown> {
  if (parsed === null || parsed === undefined) {
    throw new ConfigError(`配置文件 ${fileName} (${format}) 内容为空`)
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`配置文件 ${fileName} (${format}) 顶层必须是对象，实际是 ${Array.isArray(parsed) ? 'array' : typeof parsed}`)
  }
  return parsed as Record<string, unknown>
}

export function serializeConfig(config: unknown, format: ConfigFormat): string {
  switch (format) {
    case 'json5':
      return `${json5.stringify(config, null, 2)}\n`
    case 'yaml':
      return yaml.dump(config)
    case 'toml':
      return tomlParser.stringify(config as never)
    default:
      return `${JSON.stringify(config, null, 2)}\n`
  }
}
