export type {
  ConflictAction,
  ConflictCandidate,
  ConflictContentSource,
  ConflictDecision,
  ConflictPrompt,
  ConflictRecord,
  ConflictResolutionConfig,
} from '../domain/conflict'
export { ConflictResolutionStrategy, ConflictType } from '../domain/conflict'
export type { MergeOutcome } from './merge'
export { MAX_MERGE_LINES, threeWayMerge } from './merge'
export { conflictSummary, formatConflictReport } from './report'
export type { ConflictResolverDeps } from './resolver'
export { ConflictResolver } from './resolver'
