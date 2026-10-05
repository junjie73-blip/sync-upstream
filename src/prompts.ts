import type { ConflictCandidate, ConflictPrompt, SyncConfig } from './domain'
import process from 'node:process'
import { blue, bold, cyan, green, magenta, yellow } from 'picocolors'
import prompts from 'prompts'
import { ConflictResolutionStrategy } from './domain'
import { logger } from './logger'

function cancelled(): never {
  logger.warn(yellow('操作已取消'))
  process.exit(0)
}

const SIGNAL = { onCancel: cancelled }

/** Ask only for the fields the config file and command line left unset. */
export async function collectMissingOptions(config: SyncConfig): Promise<SyncConfig> {
  logger.info(bold(cyan('\n🔄 仓库目录同步工具')))

  const questions: prompts.PromptObject[] = []

  if (!config.upstreamRepo) {
    questions.push({
      type: 'text',
      name: 'upstreamRepo',
      message: '上游仓库 URL:',
      validate: value => value.trim() ? true : '仓库 URL 不能为空',
    })
  }
  if (!config.syncDirs || config.syncDirs.length === 0) {
    questions.push({
      type: 'list',
      name: 'syncDirs',
      message: '要同步的目录（逗号分隔）:',
      separator: ',',
      format: (value: string[]) => value.map(item => item.trim()).filter(Boolean),
      validate: value => value.length > 0 ? true : '至少要有一个目录',
    })
  }
  if (!config.upstreamBranch) {
    questions.push({ type: 'text', name: 'upstreamBranch', message: '上游分支名称:', initial: 'main' })
  }
  if (!config.companyBranch) {
    questions.push({ type: 'text', name: 'companyBranch', message: '目标仓库分支名称:', initial: 'main' })
  }
  if (!config.commitMessage) {
    questions.push({
      type: 'text',
      name: 'commitMessage',
      message: '提交消息:',
      initial: 'Sync upstream changes',
    })
  }

  questions.push(
    { type: 'confirm', name: 'autoPush', message: '同步后自动推送到目标分支?', initial: config.autoPush },
    { type: 'confirm', name: 'previewOnly', message: '启用预览模式（不修改工作区）?', initial: config.previewOnly },
    { type: 'number', name: 'concurrencyLimit', message: '失败重试时的并发文件数:', initial: config.concurrencyLimit, min: 1, max: 50 },
    { type: 'select', name: 'defaultStrategy', message: '冲突处理方式:', choices: conflictChoices(), initial: indexOfStrategy(config.conflictResolutionConfig.defaultStrategy) },
    { type: 'confirm', name: 'confirm', message: '确认开始同步?', initial: true },
  )

  const { confirm, defaultStrategy, ...answers } = await prompts(questions, SIGNAL)
  if (confirm === false)
    cancelled()

  return {
    ...config,
    ...answers,
    nonInteractive: false,
    conflictResolutionConfig: {
      ...config.conflictResolutionConfig,
      defaultStrategy: defaultStrategy as ConflictResolutionStrategy,
    },
  } as SyncConfig
}

function conflictChoices() {
  return [
    { title: '逐个文件询问', value: ConflictResolutionStrategy.PROMPT_USER },
    { title: '采用上游版本（覆盖本地）', value: ConflictResolutionStrategy.USE_SOURCE },
    { title: '保留本地版本', value: ConflictResolutionStrategy.KEEP_TARGET },
    { title: '自动三方合并（冲突写标记）', value: ConflictResolutionStrategy.AUTO_MERGE },
    { title: '跳过冲突文件', value: ConflictResolutionStrategy.SKIP },
  ]
}

function indexOfStrategy(strategy: ConflictResolutionStrategy): number {
  const index = conflictChoices().findIndex(choice => choice.value === strategy)
  return index === -1 ? 0 : index
}

/** Per-file conflict question; returning null means "keep local" (the resolver's default). */
export const conflictPrompt: ConflictPrompt = async (candidate: ConflictCandidate) => {
  const answer = await prompts({
    type: 'select',
    name: 'strategy',
    message: `冲突 ${candidate.path}（${candidate.conflictType}）如何处理?`,
    choices: conflictChoices().filter(choice => choice.value !== ConflictResolutionStrategy.PROMPT_USER),
  }, { onCancel: () => undefined })
  return (answer.strategy as ConflictResolutionStrategy | undefined) ?? null
}

export function displaySummary(config: SyncConfig, source: string | null): void {
  logger.info(bold(blue('\n🔍 配置摘要:')))
  logger.info(cyan(`  - 配置文件: ${source ?? '（未找到，使用默认值 + 命令行）'}`))
  logger.info(cyan(`  - 上游仓库: ${config.upstreamRepo}`))
  logger.info(cyan(`  - 上游分支: ${config.upstreamBranch}`))
  logger.info(cyan(`  - 目标分支: ${config.companyBranch}`))
  logger.info(yellow(`  - 同步目录: ${config.syncDirs.join(', ')}`))
  logger.info(magenta(`  - 提交消息: ${config.commitMessage}`))
  logger.info(green(`  - 自动推送: ${config.autoPush ? '是' : '否'}`))
  logger.info(green(`  - 强制覆盖: ${config.forceOverwrite ? '是' : '否（增量，按已同步 oid 跳过）'}`))
  logger.info(yellow(`  - 预览模式: ${config.previewOnly ? '启用' : '禁用'}`))
  logger.info(blue(`  - 重试: ${config.retryConfig.maxRetries} 次，初始 ${config.retryConfig.initialDelay}ms，因子 ${config.retryConfig.backoffFactor}`))
  logger.info(blue(`  - 冲突策略: ${config.conflictResolutionConfig.defaultStrategy}`))
  if (config.grayReleaseConfig?.enable) {
    logger.info(bold(yellow(`  - 灰度发布: ${config.grayReleaseConfig.strategy} ${config.grayReleaseConfig.percentage ?? ''}%`)))
  }
  logger.info(bold(blue(`${'='.repeat(40)}\n`)))
}
