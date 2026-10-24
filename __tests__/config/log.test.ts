import type { SyncConfig } from '../../src/domain'
import { cliLayer, parseArgs, unknownFlags } from '../../src/cli'
import { mergeConfigLayers } from '../../src/config/merge'
import { resolveConfig } from '../../src/config/resolve'
import { DEFAULT_LOG_CONFIG } from '../../src/domain'

const BASE = {
  upstreamRepo: 'https://git.example.com/org/upstream.git',
  upstreamBranch: 'main',
  companyBranch: 'company',
  syncDirs: ['src/config'],
  nonInteractive: true,
}

const WEBHOOK = { enable: true, port: 8080, path: '/wb', secret: 's3cret', triggerBranch: 'main' }

function resolve(extra: Record<string, unknown> = {}) {
  return resolveConfig({ ...BASE, ...extra })
}

function rejection(extra: Record<string, unknown>): string {
  try {
    resolve(extra)
  }
  catch (error) {
    return (error as Error).message
  }
  throw new Error('预期校验失败，实际通过了')
}

function flags(argv: string[]): Record<string, unknown> {
  return cliLayer(parseArgs(argv))
}

function rejected(argv: string[]): string {
  try {
    resolveConfig({ ...BASE, ...flags(argv) })
  }
  catch (error) {
    return (error as Error).message
  }
  throw new Error('预期校验失败，实际通过了')
}

/** 队列上限只在启用 webhook 时才检查，所以测试得把 `-we` 一起给上。 */
const WE = ['-we', '--webhook-port', '9090', '--webhook-path', '/wb', '--webhook-secret', 's']

describe('日志落盘配置的默认值', () => {
  it('不写 logConfig 就还是 0.2 之前的样子：只有控制台', () => {
    expect(resolve().config.logConfig).toBeUndefined()
  })

  it('写了 file 就原样交出，缺的字段由写文件的一方兜底', () => {
    // resolve 不替用户填默认值，否则配置文件里的 `{ file, level }` 会被误当成显式诉求。
    expect(resolve({ logConfig: { file: 'logs/sync.log', level: 'warn' } }).config.logConfig)
      .toEqual({ file: 'logs/sync.log', level: 'warn' })
  })

  it('默认值是 info、纯文本、5 MiB、留 5 份、没有额外密钥', () => {
    expect(DEFAULT_LOG_CONFIG).toEqual({ level: 'info', json: false, maxBytes: 5 * 1024 * 1024, keep: 5, redact: [] })
  })
})

describe('日志与审计配置的别名', () => {
  it('log 与 logging 都是整个 logConfig 的别名', () => {
    expect(resolve({ log: { file: 'a.log' } }).config.logConfig).toEqual({ file: 'a.log' })
    expect(resolve({ logging: { file: 'b.log', json: true } }).config.logConfig).toEqual({ file: 'b.log', json: true })
  })

  it('logFile / logLevel / logJson / logKeep 各归各位', () => {
    const { config } = resolve({ logFile: 'a.log', logLevel: 'error', logJson: true, logKeep: 2 })

    expect(config.logConfig).toEqual({ file: 'a.log', level: 'error', json: true, keep: 2 })
  })

  it('logMaxBytes 与 logRotate 都指轮转阈值，logRotate 只是换个说法', () => {
    expect(resolve({ logRotate: 2048 }).config.logConfig?.maxBytes).toBe(2048)
    expect(resolve({ logMaxBytes: 4096 }).config.logConfig?.maxBytes).toBe(4096)
  })

  it('webhookLog 与 webhookQueue 落在 webhookConfig 上', () => {
    const { config } = resolve({ webhookConfig: WEBHOOK, webhookLog: 'logs/deliveries.jsonl', webhookQueue: 3 })

    expect(config.webhookConfig?.deliveryLog).toBe('logs/deliveries.jsonl')
    expect(config.webhookConfig?.maxQueue).toBe(3)
  })
})

describe('日志落盘配置的校验', () => {
  it('file 必须是真的路径写法，空串和空格都不算', () => {
    expect(rejection({ logConfig: { file: '' } })).toContain('logConfig.file 必须是非空字符串')
    expect(rejection({ logConfig: { file: '   ' } })).toContain('logConfig.file')
    expect(rejection({ logConfig: { file: 42 } })).toContain('logConfig.file')
  })

  it('level 只有文件四级，控制台那些花名不接受', () => {
    const message = rejection({ logConfig: { file: 'a.log', level: 'verbose' } })

    expect(message).toContain('logConfig.level 无效')
    expect(message).toContain('debug、info、warn、error')
    for (const level of ['debug', 'info', 'warn', 'error'])
      expect(resolve({ logConfig: { file: 'a.log', level } }).config.logConfig?.level).toBe(level)
  })

  it('json 只接受布尔值', () => {
    expect(rejection({ logConfig: { file: 'a.log', json: 'yes' } })).toContain('logConfig.json 必须是布尔值')
  })

  it('maxBytes 至少 1 KiB，否则一行日志就把文件轮转没了', () => {
    expect(rejection({ logConfig: { file: 'a.log', maxBytes: 512 } })).toContain('logConfig.maxBytes 必须是不小于 1024 的整数')
    expect(rejection({ logConfig: { file: 'a.log', maxBytes: 1024.5 } })).toContain('logConfig.maxBytes')
    expect(rejection({ logConfig: { file: 'a.log', maxBytes: 'big' } })).toContain('logConfig.maxBytes')
    expect(resolve({ logConfig: { file: 'a.log', maxBytes: 1024 } }).config.logConfig?.maxBytes).toBe(1024)
  })

  it('keep 允许 0（不留历史），但不许负数、小数和一百份以上', () => {
    expect(resolve({ logConfig: { file: 'a.log', keep: 0 } }).config.logConfig?.keep).toBe(0)
    expect(rejection({ logConfig: { file: 'a.log', keep: -1 } })).toContain('logConfig.keep 必须是 0-100 的整数')
    expect(rejection({ logConfig: { file: 'a.log', keep: 101 } })).toContain('logConfig.keep')
    expect(rejection({ logConfig: { file: 'a.log', keep: 1.5 } })).toContain('logConfig.keep')
  })

  it('redact 必须是非空字符串数组', () => {
    expect(resolve({ logConfig: { file: 'a.log', redact: ['whsec_1'] } }).config.logConfig?.redact).toEqual(['whsec_1'])
    expect(rejection({ logConfig: { file: 'a.log', redact: ['whsec_1', ''] } })).toContain('logConfig.redact 必须是非空字符串数组')
    expect(rejection({ logConfig: { file: 'a.log', redact: 'whsec_1' } })).toContain('logConfig.redact')
  })
})

describe('webhook 运维配置的校验', () => {
  it('deliveryLog 空串会被拒，因为那一行审计写不出来等于没开', () => {
    expect(rejection({ webhookConfig: { ...WEBHOOK, deliveryLog: '' } })).toContain('webhookConfig.deliveryLog 必须是非空字符串')
    expect(resolve({ webhookConfig: { ...WEBHOOK, deliveryLog: 'logs/d.jsonl' } }).config.webhookConfig?.deliveryLog).toBe('logs/d.jsonl')
  })

  it('port 允许 0：端口交给系统分配，容器与 CI 里不必先猜空闲端口', () => {
    expect(resolve({ webhookConfig: { ...WEBHOOK, port: 0 } }).config.webhookConfig?.port).toBe(0)
    expect(resolve({ webhookConfig: { ...WEBHOOK, port: 65535 } }).config.webhookConfig?.port).toBe(65535)
    expect(rejection({ webhookConfig: { ...WEBHOOK, port: -1 } })).toContain('webhookConfig.port 无效')
    expect(rejection({ webhookConfig: { ...WEBHOOK, port: 65536 } })).toContain('webhookConfig.port 无效')
    expect(rejection({ webhookConfig: { ...WEBHOOK, port: 8080.5 } })).toContain('webhookConfig.port 无效')
    // `WebhookServer.start()` 本来就返回系统分配的实际端口，校验把它拦在门外，这条能力就只能在
    // 测试夹具里用了。
  })

  it('没配 deliveryLog 时提醒一次：进程退出后就无从回看', () => {
    expect(resolve({ webhookConfig: WEBHOOK }).warnings.join('\n')).toContain('webhookConfig.deliveryLog 未设置')

    const warned = resolve({ webhookConfig: { ...WEBHOOK, deliveryLog: 'logs/d.jsonl' } }).warnings.join('\n')
    expect(warned).not.toContain('webhookConfig.deliveryLog 未设置')
  })

  it('maxQueue 只能是 1-1000， seenHistory 必须为正', () => {
    expect(rejection({ webhookConfig: { ...WEBHOOK, maxQueue: 0 } })).toContain('webhookConfig.maxQueue 必须是 1-1000 的整数')
    expect(rejection({ webhookConfig: { ...WEBHOOK, maxQueue: 1001 } })).toContain('webhookConfig.maxQueue')
    expect(rejection({ webhookConfig: { ...WEBHOOK, maxQueue: 2.5 } })).toContain('webhookConfig.maxQueue')
    expect(rejection({ webhookConfig: { ...WEBHOOK, seenHistory: 0 } })).toContain('webhookConfig.seenHistory 必须是大于 0 的整数')
    expect(resolve({ webhookConfig: { ...WEBHOOK, maxQueue: 1, seenHistory: 64 } }).config.webhookConfig?.maxQueue).toBe(1)
  })

  it('healthPath 要么是以 / 开头的路径，要么是 false', () => {
    expect(rejection({ webhookConfig: { ...WEBHOOK, healthPath: 'healthz' } })).toContain('webhookConfig.healthPath 必须是以 / 开头的路径')
    expect(resolve({ webhookConfig: { ...WEBHOOK, healthPath: '/alive' } }).config.webhookConfig?.healthPath).toBe('/alive')
    expect(resolve({ webhookConfig: { ...WEBHOOK, healthPath: false } }).config.webhookConfig?.healthPath).toBe(false)
  })

  it('这些字段只在启用 webhook 时才检查，没启用就不拦', () => {
    expect(resolve({ webhookConfig: { ...WEBHOOK, enable: false, maxQueue: 0, deliveryLog: '' } }).config.webhookConfig?.enable).toBe(false)
  })
})

describe('日志与审计选项的命令行入口', () => {
  it('不给参数就不产生 logConfig 层', () => {
    expect(flags([]).logConfig).toBeUndefined()
    expect(flags(['-r', 'https://example.com/a.git']).logConfig).toBeUndefined()
  })

  it('每个开关各写一个字段', () => {
    expect(flags(['--log-file', 'a.log']).logConfig).toEqual({ file: 'a.log' })
    expect(flags(['--log-level', 'warn']).logConfig).toEqual({ level: 'warn' })
    expect(flags(['--log-json']).logConfig).toEqual({ json: true })
    expect(flags(['--log-max', '2048']).logConfig).toEqual({ maxBytes: 2048 })
    expect(flags(['--log-keep', '0']).logConfig).toEqual({ keep: 0 })
  })

  it('--no-log-json 是真的 false，不是"没写"', () => {
    expect(flags(['--no-log-json']).logConfig).toEqual({ json: false })
  })

  it('开关可以叠加，不会因为一个选项把别的字段带上', () => {
    expect(flags(['--log-file', 'a.log', '--log-level', 'error', '--log-keep', '1']).logConfig)
      .toEqual({ file: 'a.log', level: 'error', keep: 1 })
  })

  it('命令行只覆盖写到的字段，配置文件里的其余日志设置保留', () => {
    const fromFile = resolve({ logConfig: { file: 'a.log', level: 'error', keep: 9 } }).config
    const cli = cliLayer(parseArgs(['--log-level', 'warn'])) as Partial<SyncConfig>

    expect(mergeConfigLayers<SyncConfig>(fromFile, cli).logConfig).toEqual({ file: 'a.log', level: 'warn', keep: 9 })
  })

  it('--webhook-log 与 --webhook-queue 单独给也成立，和 -we 同时给也不会互相覆盖掉 enable', () => {
    expect(flags(['--webhook-log', 'd.jsonl']).webhookConfig).toEqual({ deliveryLog: 'd.jsonl' })
    expect(flags(['--webhook-queue', '2']).webhookConfig).toEqual({ maxQueue: 2 })

    const both = flags(['-we', '--webhook-port', '9090', '--webhook-path', '/wb', '--webhook-secret', 's', '--webhook-log', 'd.jsonl', '--webhook-queue', '2']).webhookConfig as Record<string, unknown>
    expect(both).toMatchObject({ enable: true, deliveryLog: 'd.jsonl', maxQueue: 2 })
  })

  it('这些开关都不算未知参数，拼错了才算', () => {
    const argv = ['--log-file', 'a.log', '--log-level', 'warn', '--log-json', '--no-log-json', '--log-max', '2048', '--log-keep', '1', '--webhook-log', 'd.jsonl', '--webhook-queue', '2']
    expect(unknownFlags(parseArgs(argv))).toEqual([])
    expect(unknownFlags(parseArgs(['--log-flle', 'a.log']))).toEqual(['log-flle'])
  })

  it('数字开关写错时在校验阶段就报错，不会带着 NaN 去轮转', () => {
    expect(rejected(['--log-max', 'abc'])).toContain('logConfig.maxBytes')
    expect(rejected(['--log-keep', 'abc'])).toContain('logConfig.keep')
    expect(rejected([...WE, '--webhook-queue', 'abc'])).toContain('webhookConfig.maxQueue')
  })

  it('--log-level 的非法值同样当场拒绝', () => {
    expect(rejected(['--log-file', 'a.log', '--log-level', 'noisy'])).toContain('logConfig.level 无效')
  })
})
