/**
 * Host-side vocabulary of the conductor domain: live views, durable change
 * payloads, message attribution, replay folds, and the scoped
 * `conductor/changed` event. Kept separate from ./types.ts (the pure
 * client-safe outlet) because these declarations pull dsh-agent, dsh-llm,
 * and cordis into the program — the one-program-per-side layout forbids that
 * on client aggregates.
 * @module @deepseek-ai/dsh-conductor
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  ConductorRef,
  ConductorSnapshot,
  ConductorView,
  TaskId,
} from './types.ts'

/** Board state-changing verbs recorded in the durable source change. */
export type ConductorOperation =
  | 'init'
  | 'edit'
  | 'set-mode'
  | 'pause'
  | 'resume'
  | 'complete'
  | 'block'
  | 'clear'
  | 'task-create'
  | 'task-edit'
  | 'task-status'
  | 'task-assign'
  | 'task-report'
  | 'handover'

/** Full-snapshot board mutation committed by a durable `conductor/change` event. */
export interface ConductorSnapshotChangeMeta {
  readonly kind: 'conductor/change'
  readonly version: 1
  readonly operation: Exclude<ConductorOperation, 'clear'>
  readonly board: ConductorSnapshot
  readonly createdAt: number
  readonly updatedAt: number
}

/** Tombstone retained when the current board is cleared. */
export interface ConductorClearChangeMeta {
  readonly kind: 'conductor/change'
  readonly version: 1
  readonly operation: 'clear'
  readonly cleared: ConductorRef
  readonly clearedAt: number
}

/** Durable change union carried by the conductor domain's own session event. */
export type ConductorChangeMeta = ConductorSnapshotChangeMeta | ConductorClearChangeMeta

/** Message attribution for a conductor's message to one of its workers. */
export interface ConductorRelayMessageSource {
  readonly kind: 'conductor'
  /** A message another agent addressed to this one (`relay` context form). */
  readonly form: 'relay'
  /** Session id of the conductor whose tool call produced the message. */
  readonly senderSessionId: SessionId
}

/** Message attribution for a worker's report delivered to the current conductor. */
export interface ConductorReportMessageSource {
  readonly kind: 'conductor-report'
  /** A message another agent addressed to this one (`relay` context form). */
  readonly form: 'relay'
  /** Session id of the reporting worker. */
  readonly senderSessionId: SessionId
}

/** Message attribution for the round driver's own notices to a conductor. */
export interface ConductorDriverMessageSource {
  readonly kind: 'conductor-driver'
  /** A runtime account shown without expanding the row (`notice` context form). */
  readonly form: 'notice'
  /** One-line account of what the driver did. */
  readonly summary: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    conductor: ConductorRelayMessageSource
    'conductor-report': ConductorReportMessageSource
    'conductor-driver': ConductorDriverMessageSource
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Complete post-mutation board state or clear tombstone. The same
     * handover change payload is appended to both the retiring and the
     * successor conductor session.
     */
    'conductor/change': ConductorChangeMeta
  }
}

/** Pure replay fold of durable conductor facts. */
export interface FoldedConductor {
  /** Current board, absent after a clear or before the first init. */
  readonly board?: ConductorSnapshot
  /** Current board creation time, absent without a current board. */
  readonly createdAt?: number
  /** Current board mutation time, absent without a current board. */
  readonly updatedAt?: number
  /** Latest mutation ref, including a clear tombstone. */
  readonly lastRef?: ConductorRef
}

/** Live notification after one durable board mutation commits. */
export interface ConductorChanged {
  readonly operation: ConductorOperation
  readonly ref: ConductorRef
  /** Absent for a clear tombstone. */
  readonly board?: ConductorView
}

/** Stable error codes for rejected conductor reads and mutations. */
export type ConductorErrorCode =
  | 'CONDUCTOR_AGENT_NOT_LIVE'
  | 'CONDUCTOR_NOT_FOUND'
  | 'CONDUCTOR_ALREADY_EXISTS'
  | 'CONDUCTOR_NOT_CONDUCTOR'
  | 'CONDUCTOR_NOT_TOP_LEVEL'
  | 'CONDUCTOR_STALE_REVISION'
  | 'CONDUCTOR_INVALID_OBJECTIVE'
  | 'CONDUCTOR_INVALID_PLAN_OUTLINE'
  | 'CONDUCTOR_INVALID_MODE'
  | 'CONDUCTOR_INVALID_MAX_PARALLEL'
  | 'CONDUCTOR_INVALID_BLOCK_REASON'
  | 'CONDUCTOR_INVALID_EDIT'
  | 'CONDUCTOR_INVALID_TRANSITION'
  | 'CONDUCTOR_TASK_NOT_FOUND'
  | 'CONDUCTOR_INVALID_TASK'
  | 'CONDUCTOR_TASK_DEPENDENCY'
  | 'CONDUCTOR_INVALID_REPORT'
  | 'CONDUCTOR_WORKER_NOT_ASSIGNED'
  | 'CONDUCTOR_CONDUCTOR_NOT_LIVE'
  | 'CONDUCTOR_INVALID_HANDOVER'
  | 'CONDUCTOR_INVALID_TASK_ID'
  | 'CONDUCTOR_WORKER_NOT_FOUND'
  | 'CONDUCTOR_SPAWN_FAILED'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Board mutation accepted into one session's log. The matching
     * `conductor/change` session event has already committed. Listener
     * failures are contained. Scope-filtered dispatch (`@deepseek-ai/dsh-scope`):
     * agent-scoped listeners receive only that agent.
     * @param payload.agent - agent whose session owns the board change.
     * @param payload.change - fresh current projection or clear tombstone.
     * @mode emit
     */
    'conductor/changed'(this: import('@deepseek-ai/dsh-scope').Scoped<Agent>, payload: {
      agent: Agent
      change: ConductorChanged
    }): void
  }
}

/** Wire-safe acknowledgement of one created board. */
export interface SpawnedWorker {
  /** The task the worker was assigned. */
  readonly taskId: TaskId
  /** The durable child session id of the worker. */
  readonly workerId: SessionId
  /** The accepted initial prompt's inbox message id. */
  readonly messageId: string
}

/** Outcome of one handover: the new conductor window identity. */
export interface HandoverResult {
  /** The durable child session id of the successor conductor window. */
  readonly childId: SessionId
  /** The accepted briefing prompt's inbox message id. */
  readonly messageId: string
}

/** Outcome of delivering one message to a worker. */
export interface DeliverResult {
  /** The accepted message's inbox id. */
  readonly messageId: string
}

/** Outcome of a worker's report: the accepted delivery to the conductor. */
export interface ReportResult {
  /** The accepted report message's inbox id. */
  readonly messageId: string
}
