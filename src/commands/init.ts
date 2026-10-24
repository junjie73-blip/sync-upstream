import type { ConfigFormat } from '../config/parse'
import type { DeletePolicy, SyncConfig } from '../domain'
import path from 'node:path'
import fs from 'fs-extra'
import { bold, cyan } from 'picocolors'
import prompts from 'prompts'
import { buildConfig, writeConfigFile } from '../config'
import { ConflictResolutionStrategy } from '../domain'
import { UserCancelError, ValidationError } from '../errors'
import { t } from '../i18n'
import { logger } from '../logger'

/**
 * The guided questionnaire.
 *
 * `--generate-config` writes the whole default block, which is a good template and a poor first
 * run: the operator still has to fill in the repo and the directories. `init` asks for the few
 * fields that actually decide what gets synced and writes only those, so the resulting file is
 * small enough to read.
 */
export interface InitAnswers {
  format: ConfigFormat
  upstreamRepo: string
  syncDirs: string[]
  upstreamBranch: string
  companyBranch: string
  commitMessage: string
  autoPush: boolean
  deletePolicy: DeletePolicy
  conflictStrategy: ConflictResolutionStrategy
}

export interface InitRequest {
  cwd: string
  /** `--config`, when the operator already knows where the file belongs. */
  configPath?: string
  /** `--config-format`, which also decides the extension of the default file name. */
  format?: ConfigFormat
  force?: boolean
}

export interface InitResult {
  path: string
  /** The merged configuration the written file resolves to, defaults included. */
  config: SyncConfig
  warnings: string[]
}

/** Asks the questions and returns the answers; throws `UserCancelError` when the operator bails. */
export type AskInit = (defaults: InitAnswers) => Promise<InitAnswers>

export const INIT_FORMAT_CHOICES: ConfigFormat[] = ['json', 'json5', 'yaml', 'toml']

/** Where `init` would write, given the flags. An explicit `--config` always wins. */
export function initTarget(request: InitRequest): string {
  const format = request.format ?? 'json'
  return path.resolve(request.cwd, request.configPath || `sync-upstream.config.${format}`)
}

/**
 * The questions answered, minus the noise: only keys that differ from the built-in defaults are
 * written, so the file says what the operator chose instead of restating twenty knobs.
 */
export function initConfig(answers: InitAnswers): Record<string, unknown> {
  const config: Record<string, unknown> = {
    upstreamRepo: answers.upstreamRepo.trim(),
    upstreamBranch: answers.upstreamBranch.trim() || 'main',
    companyBranch: answers.companyBranch.trim() || 'main',
    syncDirs: answers.syncDirs.map(item => item.trim()).filter(Boolean),
    commitMessage: answers.commitMessage,
    autoPush: answers.autoPush,
    deletePolicy: answers.deletePolicy,
    conflictResolutionConfig: { defaultStrategy: answers.conflictStrategy },
  }
  return config
}

/**
 * Ask, validate, then write.
 *
 * The candidate config goes through the same `buildConfig` a run would use before anything
 * touches the disk: an `init` that produces a file the tool then refuses to load would just move
 * the error one step later.
 */
export async function runInit(request: InitRequest, ask: AskInit): Promise<InitResult> {
  const target = initTarget(request)
  if (await fs.pathExists(target) && !request.force)
    throw new ValidationError(t('cli.initExists', { path: target }))

  const answers = await ask(defaultInitAnswers(request))
  const config = initConfig(answers)
  // 校验失败会在这里抛出，配置文件根本不会落地：init 不该产出一个下一跑就拒绝加载的文件。
  const { config: checked, warnings } = buildConfig([config])
  const written = await writeConfigFile(target, config, answers.format)
  return { path: written, config: checked, warnings }
}

export function defaultInitAnswers(request: InitRequest): InitAnswers {
  return {
    format: request.format ?? 'json',
    upstreamRepo: '',
    syncDirs: [],
    upstreamBranch: 'main',
    companyBranch: 'main',
    commitMessage: 'Sync upstream changes to specified directories',
    autoPush: false,
    deletePolicy: 'mirror',
    conflictStrategy: ConflictResolutionStrategy.PROMPT_USER,
  }
}

/**
 * The questionnaire itself, on `prompts`.
 *
 * Ctrl+C is a cancellation with an exit code, not a crash: `prompts` leaves the skipped answers
 * `undefined`, so the merged answers are checked before they are used. Tests pass their own
 * `AskInit` instead of calling this.
 */
export async function askInitPrompts(defaults: InitAnswers): Promise<InitAnswers> {
  logger.info(bold(cyan(t('cli.initTitle'))))
  const deleteChoices: DeletePolicy[] = ['mirror', 'keep', 'ask']
  const strategyChoices = [
    ConflictResolutionStrategy.USE_SOURCE,
    ConflictResolutionStrategy.KEEP_TARGET,
    ConflictResolutionStrategy.AUTO_MERGE,
    ConflictResolutionStrategy.PROMPT_USER,
    ConflictResolutionStrategy.SKIP,
  ]
  const answer = await prompts([
    {
      type: 'select',
      name: 'format',
      message: t('init.q.format'),
      choices: INIT_FORMAT_CHOICES.map(format => ({ title: format, value: format })),
      initial: Math.max(0, INIT_FORMAT_CHOICES.indexOf(defaults.format)),
    },
    {
      type: 'text',
      name: 'upstreamRepo',
      message: t('init.q.repo'),
      initial: defaults.upstreamRepo,
      validate: (value: string) => value.trim() ? true : t('cli.initRepoRequired'),
    },
    {
      type: 'list',
      name: 'syncDirs',
      message: t('init.q.dirs'),
      separator: ',',
      initial: defaults.syncDirs.join(','),
      format: (value: string[]) => value.map(item => item.trim()).filter(Boolean),
      validate: (value: string[]) => value.length > 0 ? true : t('cli.initDirsRequired'),
    },
    {
      type: 'text',
      name: 'upstreamBranch',
      message: t('init.q.upstreamBranch'),
      initial: defaults.upstreamBranch,
    },
    {
      type: 'text',
      name: 'companyBranch',
      message: t('init.q.companyBranch'),
      initial: defaults.companyBranch,
    },
    {
      type: 'text',
      name: 'commitMessage',
      message: t('init.q.message'),
      initial: defaults.commitMessage,
    },
    {
      type: 'select',
      name: 'deletePolicy',
      message: t('init.q.deletePolicy'),
      choices: deleteChoices.map(policy => ({ title: policy, value: policy })),
      initial: Math.max(0, deleteChoices.indexOf(defaults.deletePolicy)),
    },
    {
      type: 'select',
      name: 'conflictStrategy',
      message: t('init.q.conflict'),
      choices: strategyChoices.map(strategy => ({ title: strategy, value: strategy })),
      initial: Math.max(0, strategyChoices.indexOf(defaults.conflictStrategy)),
    },
    {
      type: 'confirm',
      name: 'autoPush',
      message: t('init.q.autoPush'),
      initial: defaults.autoPush,
    },
  ], {
    onCancel: () => {
      throw new UserCancelError(t('cli.aborted'))
    },
  }) as Partial<InitAnswers>

  const merged = { ...defaults, ...answer } as InitAnswers
  if (merged.upstreamRepo.trim() === '' || merged.syncDirs.length === 0)
    throw new UserCancelError(t('cli.aborted'))
  return merged
}
