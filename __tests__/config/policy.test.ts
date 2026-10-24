import { cliLayer, parseArgs, unknownFlags } from '../../src/cli'
import { resolveConfig } from '../../src/config/resolve'

const BASE = {
  upstreamRepo: 'https://git.example.com/org/upstream.git',
  upstreamBranch: 'main',
  companyBranch: 'company',
  syncDirs: ['src/config'],
  nonInteractive: true,
}

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

describe('删除策略与改名识别的默认值', () => {
  it('不写就是老行为：跟随上游删除、识别改名、阈值 60', () => {
    const { config } = resolve()

    expect(config.deletePolicy).toBe('mirror')
    expect(config.renameDetection).toBe(true)
    expect(config.renameThreshold).toBe(60)
  })

  it('写错的值直接被拒，错误消息把三个可选值说全', () => {
    expect(rejection({ deletePolicy: 'delete' })).toContain('deletePolicy 无效')
    expect(rejection({ deletePolicy: 'delete' })).toContain('mirror（跟随上游删除）')
    expect(rejection({ renameDetection: 'yes' })).toContain('renameDetection 必须是布尔值')
  })

  it('阈值只接受 1-100 的整数', () => {
    expect(resolve({ renameThreshold: 1 }).config.renameThreshold).toBe(1)
    expect(resolve({ renameThreshold: 100 }).config.renameThreshold).toBe(100)
    expect(rejection({ renameThreshold: 0 })).toContain('renameThreshold 必须是 1-100 的整数')
    expect(rejection({ renameThreshold: 101 })).toContain('renameThreshold')
    expect(rejection({ renameThreshold: 65.5 })).toContain('renameThreshold')
    // 命令行把数字当字符串读进来，归一化之后仍是数字；这里证明字符串本身不会被接受。
    expect(rejection({ renameThreshold: '60' })).toContain('renameThreshold')
  })

  it('git 的拼写（renames / findRenames / deletions）也认', () => {
    expect(resolve({ renames: false }).config.renameDetection).toBe(false)
    expect(resolve({ findRenames: false }).config.renameDetection).toBe(false)
    expect(resolve({ deletions: 'keep' }).config.deletePolicy).toBe('keep')
  })
})

describe('删除策略与改名识别互不打脸', () => {
  it('deletePolicy: keep 时关闭改名，并说明为什么', () => {
    const { config, warnings } = resolve({ deletePolicy: 'keep' })

    expect(config.renameDetection).toBe(false)
    expect(warnings.join('\n')).toContain('deletePolicy 为 keep 时已关闭重命名识别')
  })

  it('显式 --no-renames 配上 keep 也不会多出一条自相矛盾的警告', () => {
    const { warnings } = resolve({ deletePolicy: 'keep', renameDetection: false })

    // 改名已经关了，没有必要再解释一次"因为 keep 所以关"。
    expect(warnings.filter(item => item.includes('重命名识别'))).toEqual([])
  })

  it('灰度发布按百分比分批，改名不能只搬半边，所以一并关闭', () => {
    const { config, warnings } = resolve({
      grayReleaseConfig: { enable: true, strategy: 'percentage', percentage: 30 },
    })

    expect(config.renameDetection).toBe(false)
    expect(warnings.join('\n')).toContain('灰度发布期间已关闭重命名识别')
  })

  it('mirror + 改名是默认组合，不会有任何提示', () => {
    const { warnings } = resolve()

    expect(warnings.filter(item => item.includes('改名') || item.includes('重命名'))).toEqual([])
  })
})

describe('PR 模式的配置约束', () => {
  it('开启后字段逐项校验', () => {
    expect(() => resolve({ prConfig: { enable: true } })).not.toThrow()
    expect(rejection({ prConfig: { enable: true, branchPattern: '  ' } })).toContain('branchPattern')
    expect(rejection({ prConfig: { enable: true, branchPattern: 42 } })).toContain('branchPattern')
    expect(rejection({ prConfig: { enable: true, create: 'ask' } })).toContain('prConfig.create 只能是 auto 或 never')
    expect(rejection({ prConfig: { enable: true, tool: 'hub' } })).toContain('prConfig.tool 只能是 gh 或 glab')
    expect(rejection({ prConfig: { enable: true, remote: '' } })).toContain('prConfig.remote')
  })

  it('没开启时不校验，留着不影响老配置', () => {
    expect(() => resolve({ prConfig: { enable: false, create: 'ask' } })).not.toThrow()
  })

  it('与预览、分支策略、灰度发布互斥，错误里写清怎么改', () => {
    expect(rejection({ prConfig: { enable: true }, previewOnly: true })).toContain('与预览/dryRun 互斥')
    expect(rejection({ prConfig: { enable: true }, dryRun: true })).toContain('与预览/dryRun 互斥')
    expect(rejection({
      prConfig: { enable: true },
      branchStrategyConfig: { enable: true, strategy: 'feature', baseBranch: 'company', branchPattern: 'feature/sync-{date}' },
    })).toContain('与 branchStrategyConfig')
    expect(rejection({
      prConfig: { enable: true },
      grayReleaseConfig: { enable: true, strategy: 'percentage', percentage: 30 },
    })).toContain('与 grayReleaseConfig')
  })

  it('autoPush 会被关掉并说明原因：PR 模式的意义就是不推目标分支', () => {
    const { config, warnings } = resolve({ prConfig: { enable: true }, autoPush: true })

    expect(config.autoPush).toBe(false)
    expect(warnings.join('\n')).toContain('autoPush 不会推送目标分支')
  })
})

describe('命令行开关', () => {
  it('新开关都能被解析，不会被当成未知参数', () => {
    const argv = parseArgs([
      '--delete-policy',
      'ask',
      '--renames',
      '--rename-threshold',
      '80',
      '--pr',
      '--pr-branch',
      'chore/{target}-{date}',
      '--pr-remote',
      'fork',
      '--pr-title',
      '同步上游',
      '--pr-body',
      '请评审',
      '--pr-draft',
      '--pr-no-create',
    ])

    expect(unknownFlags(argv)).toEqual([])
  })

  it('--delete-policy 与 --delete/--no-delete 三种写法都落到同一个键', () => {
    expect(flags(['--delete-policy', 'keep']).deletePolicy).toBe('keep')
    expect(flags(['--no-delete']).deletePolicy).toBe('keep')
    expect(flags(['--delete']).deletePolicy).toBe('mirror')
    // `--no-delete` 必须能盖掉配置文件里的 mirror，而不是被解释成"什么都没写"。
    expect(flags(['--delete', '--no-delete']).deletePolicy).toBe('keep')
    expect(flags([]).deletePolicy).toBeUndefined()
  })

  it('--renames / --no-renames 与阈值', () => {
    expect(flags(['--no-renames']).renameDetection).toBe(false)
    expect(flags(['--renames']).renameDetection).toBe(true)
    expect(flags(['--renames', '--no-renames']).renameDetection).toBe(false)
    expect(flags(['--rename-threshold', '80']).renameThreshold).toBe(80)
    expect(flags([]).renameDetection).toBeUndefined()
    expect(flags([]).renameThreshold).toBeUndefined()
  })

  it('--pr 组装出 prConfig，子开关各管各的', () => {
    expect(flags(['--pr']).prConfig).toEqual({ enable: true })
    expect(flags(['--pr', '--pr-draft', '--pr-no-create', '--pr-remote', 'fork', '--pr-title', 't', '--pr-body', 'b']).prConfig)
      .toEqual({ enable: true, remote: 'fork', title: 't', body: 'b', draft: true, create: 'never' })
    expect(flags(['--no-pr']).prConfig).toEqual({ enable: false })
    expect(flags([]).prConfig).toBeUndefined()
  })

  it('开关写进配置层之后真的生效', () => {
    const layer = flags(['--no-delete', '--no-renames', '--pr'])
    const { config } = resolveConfig({ ...BASE, ...layer })

    expect(config.deletePolicy).toBe('keep')
    expect(config.renameDetection).toBe(false)
    expect(config.prConfig).toEqual({ enable: true })
    expect(config.autoPush).toBe(false)
  })
})
