import type { WebhookConfig, WebhookEventFilterRule } from '../domain/webhook'

/**
 * 按点分路径（如 refs.heads.name）从 payload 中取值。
 * 只做属性遍历，绝不执行任何代码；路径不存在时返回 undefined。
 */
export function getValueByPath(source: unknown, path: string): unknown {
  let current: unknown = source
  for (const part of path.split('.')) {
    if (current === null || (typeof current !== 'object' && typeof current !== 'function'))
      return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

/**
 * 无效正则的信号类型，用于把“配置错误”与“条件不匹配”区分开
 */
const INVALID_REGEX = Symbol('invalid-regex')

function matchCondition(payload: Record<string, any>, condition: WebhookEventFilterRule['conditions'][number]): boolean | typeof INVALID_REGEX {
  const field = getValueByPath(payload, condition.fieldPath)
  switch (condition.operator) {
    case 'eq':
      return field === condition.value
    case 'ne':
      return field !== condition.value
    case 'gt':
      return typeof field === 'number' && typeof condition.value === 'number' && field > condition.value
    case 'lt':
      return typeof field === 'number' && typeof condition.value === 'number' && field < condition.value
    case 'contains':
      if (Array.isArray(field))
        return field.includes(condition.value)
      return typeof field === 'string' && typeof condition.value === 'string' && field.includes(condition.value)
    case 'regex': {
      if (typeof field !== 'string')
        return false
      try {
        return new RegExp(String(condition.value)).test(field)
      }
      catch {
        return INVALID_REGEX
      }
    }
    default:
      return false
  }
}

function matchRule(payload: Record<string, any>, rule: WebhookEventFilterRule): boolean | typeof INVALID_REGEX {
  for (const condition of rule.conditions) {
    const result = matchCondition(payload, condition)
    if (result === INVALID_REGEX)
      return INVALID_REGEX
    if (!result)
      return false
  }
  return true
}

/**
 * 事件过滤：先做分支/事件白名单粗筛，再套用 eventFilterConfig.rules 精细过滤。
 * - 分支必须等于 config.triggerBranch，事件必须在 config.allowedEvents 中；
 * - 某事件一旦配置了规则，就必须至少命中一条规则；
 * - 规则中出现非法正则时以固定原因拒绝，而不是抛异常。
 */
export function shouldTriggerSync(
  config: WebhookConfig,
  delivery: { event: string, branch: string },
  payload: Record<string, any>,
): { accept: boolean, reason: string } {
  if (delivery.branch !== config.triggerBranch) {
    return { accept: false, reason: `非触发分支: ${delivery.branch || '(空)'}` }
  }
  if (!config.allowedEvents.includes(delivery.event)) {
    return { accept: false, reason: `事件不在允许列表: ${delivery.event}` }
  }

  const rules = config.eventFilterConfig?.rules?.filter(rule => rule.eventType === delivery.event) ?? []
  if (rules.length === 0) {
    return { accept: true, reason: '分支与事件均匹配' }
  }

  let matched = false
  for (const rule of rules) {
    const result = matchRule(payload, rule)
    if (result === INVALID_REGEX) {
      return { accept: false, reason: '过滤规则正则无效' }
    }
    if (result)
      matched = true
  }
  return matched
    ? { accept: true, reason: '命中事件过滤规则' }
    : { accept: false, reason: `事件 ${delivery.event} 未命中任何过滤规则` }
}
