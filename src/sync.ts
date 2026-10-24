import type { ConflictPrompt, NotifyEvent, SyncConfig } from './domain'
import type { SyncRunResult } from './pipeline/orchestrator'
import type { UndoResult } from './pipeline/undo'
import { eventFromFailure, eventFromRun, eventFromUndo, notifyEnabled, notifySafely } from './notify'
import { SyncOrchestrator } from './pipeline/orchestrator'

export interface UpstreamSyncerOptions {
  config: SyncConfig
  cwd?: string
  /** Used when `conflictResolutionConfig.defaultStrategy` is PROMPT_USER. */
  prompt?: ConflictPrompt
  /** Used when `deletePolicy` is `ask`. */
  confirmDeletes?: (count: number) => Promise<boolean>
  /**
   * Set to false when the caller owns the retry loop. Left on, a webhook daemon that retries
   * three times would announce the same failure three times.
   */
  notify?: boolean
}

/**
 * Public entry point: build an orchestrator from a resolved config and run the pipeline.
 * No git, file-system, or decision logic lives here.
 */
export class UpstreamSyncer {
  private readonly orchestrator: SyncOrchestrator

  constructor(options: UpstreamSyncerOptions) {
    this.orchestrator = new SyncOrchestrator({
      config: options.config,
      cwd: options.cwd,
      prompt: options.prompt,
      confirmDeletes: options.confirmDeletes,
    })
  }

  run(): Promise<SyncRunResult> {
    return this.orchestrator.run()
  }

  /** `--undo`: revert the most recent recorded sync, under the same repository lock. */
  undo(): Promise<UndoResult> {
    return this.orchestrator.undo()
  }
}

/**
 * Both the CLI and the webhook daemon go through these wrappers, so a notification is
 * attached to the run itself rather than to one caller. Announcing never changes the
 * outcome: a chat provider being down must not turn a good sync into a failed one, and
 * preview runs have nothing for anyone to act on.
 */
export async function announceSyncEvent(config: SyncConfig, event: NotifyEvent, isPreview: boolean): Promise<void> {
  if (!notifyEnabled(config.notifyConfig, event.outcome, isPreview))
    return
  await notifySafely(event, config.notifyConfig)
}

export async function runSync(options: UpstreamSyncerOptions): Promise<SyncRunResult> {
  const { config } = options
  const notify = options.notify !== false
  const startedAt = Date.now()
  const syncer = new UpstreamSyncer(options)
  let result: SyncRunResult
  try {
    result = await syncer.run()
  }
  catch (error) {
    if (notify)
      await announceSyncEvent(config, eventFromFailure(config, error, startedAt), false)
    throw error
  }
  if (notify)
    await announceSyncEvent(config, eventFromRun(config, result, startedAt), result.previewed)
  return result
}

export async function undoSync(options: UpstreamSyncerOptions): Promise<UndoResult> {
  const { config } = options
  const startedAt = Date.now()
  const result = await new UpstreamSyncer(options).undo()
  if (options.notify !== false)
    await announceSyncEvent(config, eventFromUndo(config, result, startedAt), false)
  return result
}

export type { SyncConfig, SyncRunResult, UndoResult }
