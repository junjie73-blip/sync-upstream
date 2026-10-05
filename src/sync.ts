import type { ConflictPrompt, SyncConfig } from './domain'
import type { SyncRunResult } from './pipeline/orchestrator'
import { SyncOrchestrator } from './pipeline/orchestrator'

export interface UpstreamSyncerOptions {
  config: SyncConfig
  cwd?: string
  /** Used when `conflictResolutionConfig.defaultStrategy` is PROMPT_USER. */
  prompt?: ConflictPrompt
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
    })
  }

  run(): Promise<SyncRunResult> {
    return this.orchestrator.run()
  }
}

export function runSync(options: UpstreamSyncerOptions): Promise<SyncRunResult> {
  return new UpstreamSyncer(options).run()
}

export type { SyncConfig, SyncRunResult }
