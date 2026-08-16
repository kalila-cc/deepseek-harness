/**
 * Pure types of the conductor domain: the ONE home of the `conductor`
 * projection-key declaration plus the durable payload vocabulary it carries,
 * free of this package's host-side imports (cordis events, dsh-agent,
 * dsh-llm, the service). Host-coupled domain vocabulary (message sources,
 * events, fold shapes) lives in ./domain.ts.
 *
 * @module @deepseek-ai/dsh-conductor/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Identifies one conductor task board across its durable revisions. */
export type ConductorId = Branded<'ConductorId'>

/** Identifies one task inside a conductor task board. */
export type TaskId = Branded<'TaskId'>

/** Compare-and-set identity for one exact board revision. */
export interface ConductorRef {
  /** Stable board identity. */
  readonly id: ConductorId
  /** Positive revision; every durable mutation increments it. */
  readonly revision: number
}

/** Deployment scheduling choice for ready tasks. */
export type ConductorMode = 'serial' | 'parallel'

/** Durable board lifecycle phase. Activation is process-local and separate. */
export type ConductorPhase =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'complete'

/** Machine-routable and human-readable explanation for a blocked board. */
export interface ConductorBlockReason {
  /** Stable lower-kebab-case classification chosen by the blocking policy. */
  readonly code: string
  /** Non-empty explanation shown to humans and models. */
  readonly message: string
}

/** Lifecycle state of one task. */
export type TaskStatus = 'todo' | 'in-progress' | 'done' | 'blocked'

/** What a worker's report claims about its assigned task. */
export type TaskReportStatus = 'progress' | 'done' | 'blocked'

/** Machine-routable and human-readable explanation for a blocked task. */
export interface TaskBlockReason {
  /** Stable lower-kebab-case classification chosen by the blocking policy. */
  readonly code: string
  /** Non-empty explanation shown to humans and models. */
  readonly message: string
}

/** One durable report a worker submitted about its assigned task. */
export interface TaskReportEntry {
  /** The claimed status at report time. */
  readonly status: TaskReportStatus
  /** Self-contained worker message (summary, blocker, or progress note). */
  readonly message: string
  /** Epoch milliseconds of the report. */
  readonly at: number
  /** Session id of the reporting worker. */
  readonly workerSessionId: SessionId
  /** Number of compactions the worker session had undergone at report time. */
  readonly workerCompactions: number
}

/** Full durable state of one task, carried by every board snapshot. */
export interface TaskSnapshot {
  /** Stable task identity. */
  readonly id: TaskId
  /** Short imperative title shown in boards and worker windows. */
  readonly title: string
  /** Self-contained work description delivered to the assigned worker. */
  readonly description: string
  /** Lifecycle state. */
  readonly status: TaskStatus
  /** Task ids that must reach `done` before this task may start. */
  readonly dependsOn: readonly TaskId[]
  /** Session id of the worker currently assigned to this task, if any. */
  readonly assignee?: SessionId
  /** Present exactly while `status` is `blocked`. */
  readonly blockedReason?: TaskBlockReason
  /** Bounded report history, oldest first. */
  readonly reports: readonly TaskReportEntry[]
}

/** Input whose omitted scheduling defaults are resolved by the service configuration. */
export interface InitConductorRequest {
  /** The user-described task objective the board pursues. */
  readonly objective: string
  /** Scheduling override; omission uses the user preference (`parallel` until changed). */
  readonly mode?: ConductorMode
  /** The implementation-plan outline the conductor wrote for the objective. */
  readonly planOutline?: string
  /** Parallel-mode cap on concurrently in-progress tasks; defaults to the service config. */
  readonly maxParallelWorkers?: number
}

/** Fields changed by a board edit; at least one must be present. */
export interface EditConductorRequest {
  readonly objective?: string
  readonly planOutline?: string
}

/** Input for one task creation; dependencies reference existing task ids. */
export interface CreateTaskRequest {
  /** Short imperative title. */
  readonly title: string
  /** Self-contained work description delivered to the assigned worker. */
  readonly description: string
  /** Task ids that must reach `done` before this task may start. */
  readonly dependsOn?: readonly TaskId[]
}

/** Fields changed by a task edit; at least one must be present. */
export interface EditTaskRequest {
  readonly title?: string
  readonly description?: string
  readonly dependsOn?: readonly TaskId[]
}

/** Input for a worker's report about its assigned task. */
export interface TaskReportRequest {
  /** The task this worker is assigned to. */
  readonly taskId: TaskId
  /** The claimed status. */
  readonly status: TaskReportStatus
  /** Self-contained message: summary, blocker, or progress note. */
  readonly message: string
}

/** Full durable state written by every non-clear board mutation. */
export interface ConductorSnapshot extends ConductorRef {
  /** The user-described task objective. */
  readonly objective: string
  /** The implementation-plan outline the conductor wrote. */
  readonly planOutline: string
  /** Deployment scheduling choice. */
  readonly mode: ConductorMode
  /** Parallel-mode cap on concurrently in-progress tasks. */
  readonly maxParallelWorkers: number
  /** Durable lifecycle phase. */
  readonly phase: ConductorPhase
  /** Present exactly while `phase` is `blocked`. */
  readonly blockedReason?: ConductorBlockReason
  /** Session id of the window currently holding the conductor role. */
  readonly conductorSessionId: SessionId
  /** How many times the conductor role has been handed to a new window. */
  readonly handoverCount: number
  /** All tasks, in creation order. */
  readonly tasks: readonly TaskSnapshot[]
}

/** Whether this live process may automatically advance an active board. */
export type ConductorActivation = 'armed' | 'disarmed'

/** Current board projection, including values derived from the session log. */
export interface ConductorView extends ConductorSnapshot {
  /** Epoch milliseconds of the init mutation. */
  readonly createdAt: number
  /** Epoch milliseconds of the latest mutation. */
  readonly updatedAt: number
  /** Process-local continuation eligibility; never persisted. */
  readonly activation: ConductorActivation
  /** Compaction count of the session owning this view at read time. */
  readonly compactionCount: number
}

/**
 * The `conductor` projection value: the current durable board with its replay
 * counters, exactly as the latest `conductor/change` event carried them.
 * Activation and compaction counts are process-local or session-derived and
 * deliberately absent — the projection reflects durable state only.
 */
export interface ConductorProjection {
  /** Current durable board snapshot (the CAS ref for mutations rides on it). */
  readonly board: ConductorSnapshot
  /** Epoch milliseconds of the init mutation. */
  readonly createdAt: number
  /** Epoch milliseconds of the latest mutation. */
  readonly updatedAt: number
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * The session's current conductor board (the latest `conductor/change`
     * whole value), or `null` before the first init and after a clear
     * tombstone. Whole-value rule: every board change carries the complete
     * post-change state, so the fold is last-wins.
     */
    conductor: ConductorProjection | null
  }
}
