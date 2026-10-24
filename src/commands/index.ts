import type { CommandContext, CommandOutput } from './types'
import { ValidationError } from '../errors'
import { t } from '../i18n'
import { doctorCommand } from './doctor'
import { historyCommand } from './history'
import { appendCiSummary, emit } from './output'
import { statusCommand } from './status'
import { whyCommand } from './why'

export const SUBCOMMANDS = ['status', 'why', 'doctor', 'history'] as const

/** The individual handlers, for library users that want the documents without the CLI. */
export { doctorCommand } from './doctor'
export { historyCommand } from './history'
export { statusCommand } from './status'
export { whyCommand } from './why'

export type Subcommand = typeof SUBCOMMANDS[number]

export function isSubcommand(value: unknown): value is Subcommand {
  return typeof value === 'string' && (SUBCOMMANDS as readonly string[]).includes(value)
}

const HANDLERS: Record<Subcommand, (context: CommandContext) => Promise<CommandOutput<any>>> = {
  status: statusCommand,
  why: whyCommand,
  doctor: doctorCommand,
  history: historyCommand,
}

/**
 * The rows `--help` prints under the subcommands.
 *
 * `description` is a getter rather than a plain string: the module is loaded before the
 * locale is known (the `--lang` flag is only parsed after that), and a literal would freeze
 * whatever language happened to be active at import time into every later `--help`.
 */
export const SUBCOMMAND_HELP: Array<{ name: Subcommand, usage: string, description: string }> = [
  { name: 'status', usage: 'sync-upstream status [--fetch]', get description() { return t('sc.status') } },
  {
    name: 'why',
    get usage() { return `sync-upstream why ${t('sc.whyArg')}` },
    get description() { return t('sc.why') },
  },
  { name: 'doctor', usage: 'sync-upstream doctor', get description() { return t('sc.doctor') } },
  { name: 'history', usage: 'sync-upstream history [--limit <n>]', get description() { return t('sc.history') } },
]

/**
 * Run a subcommand and print either its lines or one JSON document.
 * Returns the process exit code; nothing here mutates the repository.
 */
export async function runSubcommand(name: Subcommand, context: CommandContext): Promise<number> {
  const handler = HANDLERS[name]
  if (!handler)
    throw new ValidationError(t('e.unknownSubcommand', { name }))

  const output = await handler(context)
  // The handler was handed a configuration it had to work around; the report has to say so even
  // though the handler itself completed.
  for (const problem of context.configProblems ?? [])
    output.report.warnings.push(t('v.lenientProblem', { problem }))
  if (output.report.summary) {
    const warning = await appendCiSummary(output.report.summary)
    if (warning)
      output.report.warnings.push(warning)
  }
  emit(output.report, output.lines, context.json)
  return output.report.exitCode
}
