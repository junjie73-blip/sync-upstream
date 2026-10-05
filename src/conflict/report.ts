import type { ConflictAction, ConflictDecision } from '../domain/conflict'
import { cyan, gray, green, yellow } from 'picocolors'

const ACTION_ORDER: ConflictAction[] = ['take-upstream', 'write-merged', 'keep-local', 'skip']

const ACTION_STYLES: Record<ConflictAction, { label: string, color: (value: string) => string }> = {
  'take-upstream': { label: '采用上游', color: green },
  'write-merged': { label: '写入合并结果', color: yellow },
  'keep-local': { label: '保留本地', color: cyan },
  'skip': { label: '跳过', color: gray },
}

/** 每条决策一行，按 action 分组输出，供 CLI 结尾打印。 */
export function formatConflictReport(decisions: ConflictDecision[]): string[] {
  const lines: string[] = []
  for (const action of ACTION_ORDER) {
    const group = decisions.filter(decision => decision.action === action)
    if (group.length === 0)
      continue
    const { label, color } = ACTION_STYLES[action]
    for (const decision of group) {
      const detail = decision.detail ? color(` — ${decision.detail}`) : ''
      lines.push(`${color(`[${label}]`)} ${decision.path}${detail}`)
    }
  }
  return lines
}

/** 各 action 的计数，四种动作恒定出现（未用到的为 0）。 */
export function conflictSummary(decisions: ConflictDecision[]): Record<ConflictAction, number> {
  const summary: Record<ConflictAction, number> = {
    'take-upstream': 0,
    'write-merged': 0,
    'keep-local': 0,
    'skip': 0,
  }
  for (const decision of decisions) summary[decision.action] = (summary[decision.action] ?? 0) + 1
  return summary
}
