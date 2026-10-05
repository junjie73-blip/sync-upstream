import type {
  ConflictCandidate,
  ConflictContentSource,
  ConflictDecision,
  ConflictPrompt,
  ConflictRecord,
  ConflictResolutionConfig,
} from '../domain/conflict'
import { ConflictResolutionStrategy } from '../domain/conflict'
import { toError, ValidationError } from '../errors'
import { extensionOf } from '../fsx/paths'
import { logger } from '../logger'
import { threeWayMerge } from './merge'

export interface ConflictResolverDeps {
  prompt?: ConflictPrompt
  onResolved?: (record: ConflictRecord) => void
}

const KNOWN_STRATEGIES: string[] = Object.values(ConflictResolutionStrategy)

type DecisionBody = Omit<ConflictDecision, 'path' | 'conflictType'>

/**
 * 冲突决策器：逐条候选给出 ConflictDecision。
 *
 * - PROMPT_USER 每个候选至多提示一次，绝不递归回自身；
 * - autoResolveTypes 中的扩展名跳过提示，直接落回保守的本地保留；
 * - 未知策略值抛 ValidationError（快速失败）；
 * - 单个候选的读取/合并异常只影响该候选，记为 skip 且不中断整批。
 */
export class ConflictResolver {
  private readonly config: ConflictResolutionConfig
  private readonly deps: ConflictResolverDeps

  constructor(config: ConflictResolutionConfig, deps: ConflictResolverDeps = {}) {
    this.config = config
    this.deps = deps
  }

  async resolve(candidates: ConflictCandidate[], contents: ConflictContentSource): Promise<ConflictDecision[]> {
    const decisions: ConflictDecision[] = []
    for (const candidate of candidates) decisions.push(await this.resolveOne(candidate, contents))
    return decisions
  }

  private async resolveOne(candidate: ConflictCandidate, contents: ConflictContentSource): Promise<ConflictDecision> {
    let strategy = this.config.defaultStrategy
    const autoResolve = (this.config.autoResolveTypes ?? []).includes(extensionOf(candidate.path))

    if (strategy === ConflictResolutionStrategy.PROMPT_USER) {
      if (autoResolve) {
        return this.record(candidate, {
          strategy,
          action: 'keep-local',
          detail: '自动解决类型未提示，保留本地版本',
        })
      }

      let answer: ConflictResolutionStrategy | null | undefined
      try {
        answer = this.deps.prompt ? await this.deps.prompt(candidate) : null
      }
      catch (error) {
        return this.record(candidate, {
          strategy,
          action: 'skip',
          detail: `处理失败: ${toError(error).message}`,
        })
      }

      if (answer === null || answer === undefined || answer === ConflictResolutionStrategy.PROMPT_USER) {
        return this.record(candidate, { strategy, action: 'keep-local', detail: '用户未选择，保留本地版本' })
      }
      strategy = answer
    }

    this.assertKnownStrategy(strategy)

    try {
      return this.record(candidate, await this.apply(candidate, strategy, contents))
    }
    catch (error) {
      // 未知策略属于配置错误，必须让整批失败；其余异常只隔离单候选。
      if (error instanceof ValidationError)
        throw error
      logger.warn(`冲突处理失败: ${candidate.path}`)
      return this.record(candidate, {
        strategy,
        action: 'skip',
        detail: `处理失败: ${toError(error).message}`,
      })
    }
  }

  private async apply(
    candidate: ConflictCandidate,
    strategy: ConflictResolutionStrategy,
    contents: ConflictContentSource,
  ): Promise<DecisionBody> {
    switch (strategy) {
      case ConflictResolutionStrategy.AUTO_MERGE:
        return await this.applyAutoMerge(candidate, contents)
      case ConflictResolutionStrategy.USE_SOURCE:
        return { strategy, action: 'take-upstream', detail: '采用上游版本' }
      case ConflictResolutionStrategy.KEEP_TARGET:
        return { strategy, action: 'keep-local', detail: '保留本地版本' }
      case ConflictResolutionStrategy.SKIP:
        return { strategy, action: 'skip', detail: '跳过该文件' }
      default:
        throw new ValidationError(`未知的冲突解决策略: ${String(strategy)}`, undefined, { path: candidate.path })
    }
  }

  private async applyAutoMerge(candidate: ConflictCandidate, contents: ConflictContentSource): Promise<DecisionBody> {
    const strategy = ConflictResolutionStrategy.AUTO_MERGE
    const [base, local, upstream] = await Promise.all([
      contents.base(candidate.path),
      contents.local(candidate.path),
      contents.upstream(candidate.path),
    ])
    const outcome = threeWayMerge(base, local, upstream)

    if (outcome.status === 'both-deleted')
      return { strategy, action: 'skip', detail: '双方均已删除，跳过' }
    if (outcome.status === 'binary')
      return { strategy, action: 'skip', detail: '二进制文件无法自动合并' }
    if (outcome.status === 'conflict') {
      return {
        strategy,
        action: 'write-merged',
        mergedContent: outcome.content,
        detail: `自动合并存在 ${outcome.conflictCount ?? 1} 处冲突，已写入冲突标记`,
      }
    }

    if (base === upstream)
      return { strategy, action: 'keep-local', detail: '自动合并成功（仅本地改动）' }
    if (base === local)
      return { strategy, action: 'take-upstream', detail: '自动合并成功（仅上游改动）' }
    if (outcome.content === undefined)
      return { strategy, action: 'keep-local', detail: '自动合并成功（接受删除）' }
    if (outcome.content === upstream)
      return { strategy, action: 'take-upstream', detail: '自动合并成功' }
    if (outcome.content === local)
      return { strategy, action: 'keep-local', detail: '自动合并成功' }
    return { strategy, action: 'write-merged', mergedContent: outcome.content, detail: '自动合并成功' }
  }

  private assertKnownStrategy(strategy: ConflictResolutionStrategy): void {
    if (!KNOWN_STRATEGIES.includes(strategy as string)) {
      throw new ValidationError(`未知的冲突解决策略: ${String(strategy)}`, undefined, { strategy })
    }
  }

  private record(candidate: ConflictCandidate, body: DecisionBody): ConflictDecision {
    const decision: ConflictDecision = { path: candidate.path, conflictType: candidate.conflictType, ...body }
    if (this.config.logResolutions !== false) {
      this.deps.onResolved?.({
        path: candidate.path,
        type: candidate.conflictType,
        strategy: body.strategy,
        action: body.action,
        detail: body.detail,
      })
    }
    return decision
  }
}
