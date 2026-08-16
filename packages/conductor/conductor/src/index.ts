/**
 * Conductor domain: event-sourced task-board state, compare-and-set
 * mutations, worker scheduling and delivery, and the handover of the
 * conductor role to a fresh window.
 * @module @deepseek-ai/dsh-conductor
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type SessionTitleService from '@deepseek-ai/dsh-session-title'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'
import type { ContinuableStart, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-compaction/types'
import {
  applyConductorEvent,
  conductorChangeRef,
  decodeConductorChange,
  emptyConductorFoldState,
} from './fold.ts'
import type { ConductorFoldState } from './fold.ts'
import { planScheduling, planWorkerStarts } from './scheduling.ts'
import {
  DEFAULT_WORKER_PERSONA,
  renderHandoverBriefing,
  renderReportMessage,
  renderWorkerPrompt,
} from './prompt.ts'
import {
  CONDUCTOR_CHANGE_VERSION,
  ConductorError,
  ConductorId as brandConductorId,
  TaskId as brandTaskId,
} from './runtime.ts'
import type {
  CreateTaskRequest,
  EditConductorRequest,
  EditTaskRequest,
  InitConductorRequest,
  TaskReportRequest,
  TaskStatus,
} from './types.ts'
import type {
  ConductorActivation,
  ConductorMode,
  ConductorSnapshot,
  ConductorView,
  ConductorRef,
  ConductorProjection,
  TaskBlockReason,
  TaskReportEntry,
  TaskSnapshot,
  TaskId,
} from './types.ts'
import type {
  ConductorChangeMeta,
  ConductorChanged,
  ConductorClearChangeMeta,
  ConductorOperation,
  ConductorSnapshotChangeMeta,
  DeliverResult,
  HandoverResult,
  ReportResult,
  SpawnedWorker,
} from './domain.ts'

// The pure payload outlet (./types.ts, ONE home of the `conductor`
// projection-key declaration) re-exported onto the package root keeps the
// module edge in the emitted index.d.ts, so aggregate programs consuming the
// declarations still receive the SessionProjectionMap merge.
export type * from './types.ts'
export type * from './domain.ts'
export { CONDUCTOR_CHANGE_VERSION, ConductorError, ConductorId, TaskId } from './runtime.ts'
export { decodeConductorChange, foldConductor, conductorChangeRef } from './fold.ts'
export { planScheduling, planWorkerStarts, allTasksDone } from './scheduling.ts'
export { conductorToolExecution } from './authority.ts'
export {
  DEFAULT_WORKER_PERSONA,
  renderWorkerPrompt,
  renderHandoverBriefing,
  renderReportMessage,
  renderBlockedNotice,
  renderCompleteNotice,
} from './prompt.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    conductor: ConductorService
  }
}

/** Wire payload schema of the `conductor` projection (whole current board or pre-init/cleared null). */
const conductorProjectionSchema: ZodType<ConductorProjection | null> = zod.union([
  zod.object({
    board: zod.object({
      id: zod.string().min(1),
      revision: zod.number().int().positive(),
      objective: zod.string().min(1),
      planOutline: zod.string(),
      mode: zod.union([zod.literal('serial'), zod.literal('parallel')]),
      maxParallelWorkers: zod.number().int().positive(),
      phase: zod.union([
        zod.literal('active'),
        zod.literal('paused'),
        zod.literal('blocked'),
        zod.literal('complete'),
      ]),
      blockedReason: zod.object({ code: zod.string(), message: zod.string() }).optional(),
      conductorSessionId: zod.string().min(1),
      handoverCount: zod.number().int().nonnegative(),
      tasks: zod.array(zod.object({
        id: zod.string().min(1),
        title: zod.string().min(1),
        description: zod.string().min(1),
        status: zod.union([
          zod.literal('todo'),
          zod.literal('in-progress'),
          zod.literal('done'),
          zod.literal('blocked'),
        ]),
        dependsOn: zod.array(zod.string().min(1)),
        assignee: zod.string().min(1).optional(),
        blockedReason: zod.object({ code: zod.string(), message: zod.string() }).optional(),
        reports: zod.array(zod.object({
          status: zod.union([
            zod.literal('progress'),
            zod.literal('done'),
            zod.literal('blocked'),
          ]),
          message: zod.string().min(1),
          at: zod.number().int().nonnegative(),
          workerSessionId: zod.string().min(1),
          workerCompactions: zod.number().int().nonnegative(),
        })),
      })),
    }),
    createdAt: zod.number(),
    updatedAt: zod.number(),
  }),
  zod.null(),
]) as ZodType<ConductorProjection | null>

/**
 * Light last-wins fold of the `conductor` projection unit. Unlike the strict
 * replay fold (fold.ts: transition validation, fail-loud on malformed
 * changes, Set-typed state), this transition is projection-grade: the state
 * is plain JSON (persisted-cache precondition), any non-conductor or
 * malformed event returns the same reference (the registry's Object.is gate —
 * the title/todos posture), and correctness of the written change is the
 * write side's job (ConductorService validated it before appending; the
 * package invariant rejects a violating stream fail-loud where it is
 * installed).
 * @param state - the projection covering all prior events.
 * @param event - the next committed session event.
 * @returns the next projection (same reference when the event is not a conductor change).
 */
export function applyConductorProjection(state: ConductorProjection | null, event: SessionEvent): ConductorProjection | null {
  if (event.type !== 'conductor/change') return state
  let change: ConductorChangeMeta | undefined
  try {
    change = decodeConductorChange(event.data)
  } catch (_invalidPersistedConductorChange) {
    return state
  }
  if (change === undefined) return state
  return change.operation === 'clear'
    ? null
    : {
      board: change.board,
      createdAt: change.createdAt,
      updatedAt: change.updatedAt,
    }
}

/** Deployment defaults for board creation and worker composition. */
export interface Config {
  /** Provider name that establishes worker windows (must support continuable creation). */
  workerProvider?: string
  /** Provider name that establishes successor conductor windows on handover. */
  handoverProvider?: string
  /** Worker persona shadowing the deployment persona inside every worker window. */
  workerPersona?: string
  /** Tool scoping applied to every worker window; defaults to denying the conductor-only tools. */
  workerToolFilter?: { allow?: string[]; deny?: string[] }
  /** Parallel cap used when an init request omits its own cap. */
  maxParallelWorkers?: number
  /** Upper bound on report entries retained per task. */
  reportHistoryLimit?: number
}

/** Resolved defaults. */
export interface ResolvedConfig {
  readonly workerProvider: string
  readonly handoverProvider: string
  readonly workerPersona: string
  readonly workerToolFilter: ToolRestriction | undefined
  readonly maxParallelWorkers: number
  readonly reportHistoryLimit: number
}

/** Conductor-only tool names denied to worker windows by default. */
export const CONDUCTOR_TOOL_NAMES: readonly string[] = [
  'conductor_init',
  'task_create',
  'task_update',
  'conductor_update',
  'task_board',
  'task_schedule',
  'conductor_message',
  'conductor_handover',
]

/**
 * The `conductor` settings namespace: the user-preferred scheduling mode that
 * `init` applies when the init request names none, so a person can preset
 * serial or parallel execution from the GUI instead of instructing the model.
 * The namespace is registered only when a settings provider is composed;
 * without one, `init` falls back to its own `serial` default.
 */
export const CONDUCTOR_SETTINGS_NAMESPACE = 'conductor'

/** The scheduling-mode setting of the `conductor` namespace. */
export const CONDUCTOR_SETTINGS_SCHEMA = z.object({
  mode: z.union(['serial', 'parallel'] as const).default('parallel'),
})

/** The resolved user-preferred scheduling mode. */
interface ConductorSettings {
  readonly mode: ConductorMode
}

/** Process-local cache plus activation intent crossing the synchronous append boundary. */
interface ConductorCache {
  readonly state: ConductorFoldState
  activation: ConductorActivation
  observedSeq: number
  pendingActivation: { readonly seq: number; readonly activation: ConductorActivation } | undefined
}

/** Validate a caller-visible positive safe-integer cap. */
function resolvePositiveInt(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ConductorError(`${field} must be a positive safe integer`, 'CONDUCTOR_INVALID_MAX_PARALLEL')
  }
  return value
}

/** Validate and normalize an objective at the domain boundary. */
function resolveObjective(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ConductorError('conductor objective must be a non-empty string', 'CONDUCTOR_INVALID_OBJECTIVE')
  }
  return value.trim()
}

/** Validate and normalize a plan outline at the domain boundary. */
function resolvePlanOutline(value: string): string {
  if (typeof value !== 'string' || value !== value.trim()) {
    throw new ConductorError('conductor plan outline must be a normalized string', 'CONDUCTOR_INVALID_PLAN_OUTLINE')
  }
  return value
}

/** Validate a scheduling mode at the domain boundary. */
function resolveMode(value: unknown): ConductorMode {
  if (value !== 'serial' && value !== 'parallel') {
    throw new ConductorError('conductor mode must be "serial" or "parallel"', 'CONDUCTOR_INVALID_MODE')
  }
  return value
}

/** Validate and detach one policy-owned blocker explanation. */
function resolveBlockReason(reason: unknown): TaskBlockReason {
  const record = typeof reason === 'object' && reason !== null && !Array.isArray(reason)
    ? reason as Record<string, unknown>
    : undefined
  const code = record?.['code']
  const message = record?.['message']
  if (typeof code !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(code)
    || typeof message !== 'string' || message.trim().length === 0) {
    throw new ConductorError(
      'conductor block reason requires a lower-kebab-case code and a non-empty message',
      'CONDUCTOR_INVALID_BLOCK_REASON',
    )
  }
  return { code, message: message.trim() }
}

/**
 * Conductor service (`ctx.conductor`): the event-sourced task board of one
 * conductor window, its worker scheduling, delivery, and handover.
 */
export class ConductorService extends Service {
  static inject = ['agents', 'sessions', 'subagents']

  static Config: z<Config> = z.object({
    workerProvider: z.string().default('spawn'),
    handoverProvider: z.string().default('spawn'),
    workerPersona: z.string().default(DEFAULT_WORKER_PERSONA),
    workerToolFilter: z.object({
      allow: z.array(z.string()).default(undefined as unknown as string[]),
      deny: z.array(z.string()).default(undefined as unknown as string[]),
    }).default(undefined as unknown as { allow: string[]; deny: string[] }),
    maxParallelWorkers: z.number().default(3),
    reportHistoryLimit: z.number().default(8),
  })

  private readonly resolved: ResolvedConfig
  private readonly caches = new WeakMap<Session, ConductorCache>()
  /** The settings scope when a settings provider is composed; absent otherwise. */
  private settings: SettingsScope<ConductorSettings> | undefined
  /** The session-title service when composed; absent otherwise. */
  private title: SessionTitleService | undefined

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'conductor')
    this.resolved = {
      workerProvider: config.workerProvider ?? 'spawn',
      handoverProvider: config.handoverProvider ?? 'spawn',
      workerPersona: config.workerPersona ?? DEFAULT_WORKER_PERSONA,
      workerToolFilter: config.workerToolFilter ?? { deny: [...CONDUCTOR_TOOL_NAMES] },
      maxParallelWorkers: resolvePositiveInt(config.maxParallelWorkers ?? 3, 'maxParallelWorkers'),
      reportHistoryLimit: resolvePositiveInt(config.reportHistoryLimit ?? 8, 'reportHistoryLimit'),
    }
    // The scheduling-mode setting is optional: settings is a host-plane
    // service, so the domain still resolves its own serial default in
    // compositions without one (headless leaves, tests).
    ctx.inject(['settings'], (settingsCtx) => {
      this.settings = settingsCtx.settings.register(
        settingsNamespace(CONDUCTOR_SETTINGS_NAMESPACE),
        CONDUCTOR_SETTINGS_SCHEMA,
      )
      settingsCtx.effect(() => () => {
        this.settings = undefined
      }, 'conductor.settings()')
    })
    // The session-title service is optional: worker windows are titled by
    // their task when one is composed, and left untitled otherwise.
    ctx.inject(['sessionTitle'], (titleCtx) => {
      this.title = titleCtx.sessionTitle
      titleCtx.effect(() => () => {
        this.title = undefined
      }, 'conductor.title()')
    })
    ctx.on('agent/session-start', ({ agent }) => {
      const cache = this.cache(agent.session)
      // A session that is the current conductor of an active board resumes
      // its mandate automatically: the user's original objective is the
      // standing authorization to keep advancing until they stop it.
      cache.activation = cache.state.board !== undefined
        && cache.state.board.conductorSessionId === agent.session.id
        && cache.state.board.phase === 'active'
        ? 'armed'
        : 'disarmed'
    })
    // The `conductor` projection unit: last-wins fold of conductor/change
    // whole values (see applyConductorProjection). The unit child activates
    // only when a projection registry is composed (headless assemblies stay
    // unaffected). The pure fold is covered by projection.spec; the
    // registration block itself is composition-gated.
    /* v8 ignore next 11 -- the block activates only under a mounted projection registry */
    ctx.inject(['sessionProjections'], (projectionCtx) => {
      projectionCtx.sessionProjections.register<'conductor', ConductorProjection | null>({
        key: 'conductor',
        schema: conductorProjectionSchema,
        init: () => null,
        apply: applyConductorProjection,
        view: state => state,
        stateVersion: 1,
      })
    })
  }

  /**
   * Read the board of one exact live agent's session.
   * @param agent - the live agent whose session log holds the board.
   * @returns a fresh view or `undefined` when its session has no board.
   * @throws {@link ConductorError} when the agent is not the registry's live instance.
   */
  get(agent: Agent): ConductorView | undefined {
    this.assertLive(agent)
    const cache = this.cache(agent.session)
    this.sync(agent.session, cache)
    return this.view(agent.session, cache)
  }

  /**
   * Remove process-local continuation authority without changing durable
   * board phase or revision. Lifecycle owners use this before unloading a
   * driver; a later session-start or resume re-arms the current conductor.
   * @param agent - owning live agent.
   * @returns a fresh disarmed view, or `undefined` when no board is current.
   */
  disarm(agent: Agent): ConductorView | undefined {
    this.assertLive(agent)
    const cache = this.cache(agent.session)
    this.sync(agent.session, cache)
    cache.activation = 'disarmed'
    return this.view(agent.session, cache)
  }

  /**
   * Create and arm a board; the calling session becomes the conductor. A
   * completed board may be replaced; every other current phase must be
   * cleared or resumed instead. Only a top-level session (not a delegated
   * worker) may become a conductor.
   * @param agent - owning live agent.
   * @param request - objective, mode, plan outline, and optional parallel cap.
   * @returns the created live view.
   */
  init(agent: Agent, request: InitConductorRequest): ConductorView {
    this.assertLive(agent)
    this.assertTopLevel(agent)
    const cache = this.prepareMutation(agent)
    const current = cache.state.board
    if (current !== undefined && current.phase !== 'complete') {
      throw new ConductorError(
        `board "${current.id}" already exists with phase "${current.phase}"`,
        'CONDUCTOR_ALREADY_EXISTS',
      )
    }
    const now = Date.now()
    const board: ConductorSnapshot = {
      id: brandConductorId(`conductor-${randomUUID()}`),
      revision: 1,
      objective: resolveObjective(request.objective),
      planOutline: resolvePlanOutline(request.planOutline ?? ''),
      mode: resolveMode(request.mode ?? this.settings?.get().mode ?? 'parallel'),
      maxParallelWorkers: resolvePositiveInt(
        request.maxParallelWorkers ?? this.resolved.maxParallelWorkers,
        'maxParallelWorkers',
      ),
      phase: 'active',
      conductorSessionId: agent.session.id,
      handoverCount: 0,
      tasks: [],
    }
    return this.commitSnapshot(agent, cache, 'init', board, now, now, 'armed')
  }

  /**
   * Edit objective and/or plan outline without changing phase, mode, or tasks.
   * @param agent - owning live agent (the current conductor).
   * @param ref - expected current revision.
   * @param request - at least one replacement field.
   * @returns the edited view.
   */
  edit(agent: Agent, ref: ConductorRef, request: EditConductorRequest): ConductorView {
    const cache = this.prepareMutation(agent)
    const current = this.expectCurrent(cache, ref)
    this.requireConductor(agent, current)
    if (request.objective === undefined && request.planOutline === undefined) {
      throw new ConductorError('conductor edit requires objective and/or planOutline', 'CONDUCTOR_INVALID_EDIT')
    }
    const objective = request.objective === undefined
      ? current.objective
      : resolveObjective(request.objective)
    const planOutline = request.planOutline === undefined
      ? current.planOutline
      : resolvePlanOutline(request.planOutline)
    if (objective === current.objective && planOutline === current.planOutline) {
      throw new ConductorError('conductor edit must change the objective or planOutline', 'CONDUCTOR_INVALID_EDIT')
    }
    const board: ConductorSnapshot = {
      ...current,
      revision: current.revision + 1,
      objective,
      planOutline,
    }
    return this.commitCurrent(agent, cache, 'edit', board, cache.activation)
  }

  /**
   * Switch the scheduling mode and/or the parallel cap without changing the
   * board definition or tasks.
   * @param agent - owning live agent (the current conductor).
   * @param ref - expected current revision.
   * @param mode - the new scheduling mode.
   * @param maxParallelWorkers - the new parallel cap.
   * @returns the switched view.
   */
  setMode(agent: Agent, ref: ConductorRef, mode: ConductorMode, maxParallelWorkers?: number): ConductorView {
    const cache = this.prepareMutation(agent)
    const current = this.expectCurrent(cache, ref)
    this.requireConductor(agent, current)
    const resolvedMode = resolveMode(mode)
    const resolvedCap = maxParallelWorkers === undefined
      ? current.maxParallelWorkers
      : resolvePositiveInt(maxParallelWorkers, 'maxParallelWorkers')
    if (resolvedMode === current.mode && resolvedCap === current.maxParallelWorkers) {
      throw new ConductorError('conductor set-mode must change the mode or the parallel cap', 'CONDUCTOR_INVALID_EDIT')
    }
    const board: ConductorSnapshot = {
      ...current,
      revision: current.revision + 1,
      mode: resolvedMode,
      maxParallelWorkers: resolvedCap,
    }
    return this.commitCurrent(agent, cache, 'set-mode', board, cache.activation)
  }

  /**
   * Pause an active board and disarm automatic advancement.
   * @param agent - owning live agent (the current conductor).
   * @param ref - expected current revision.
   * @returns the paused view.
   */
  pause(agent: Agent, ref: ConductorRef): ConductorView {
    return this.transition(agent, ref, 'pause', ['active'], 'paused', 'disarmed')
  }

  /**
   * Resume and arm a stopped board, or rearm an active board after a
   * session-start edge.
   * @param agent - owning live agent (the current conductor).
   * @param ref - expected current revision.
   * @returns the active view.
   */
  resume(agent: Agent, ref: ConductorRef): ConductorView {
    const cache = this.prepareMutation(agent)
    const current = this.expectCurrent(cache, ref)
    this.requireConductor(agent, current)
    const resumable: readonly ConductorSnapshot['phase'][] = ['active', 'paused', 'blocked']
    if (!resumable.includes(current.phase)) {
      throw this.transitionError(current, 'resume', resumable)
    }
    if (current.phase === 'active' && cache.activation === 'armed') {
      throw new ConductorError(`board "${current.id}" is already active and armed`, 'CONDUCTOR_INVALID_TRANSITION')
    }
    return this.commitCurrent(agent, cache, 'resume', this.withPhase(current, 'active'), 'armed')
  }

  /**
   * Mark a current non-complete board complete and disarm it.
   * @param agent - owning live agent (the current conductor).
   * @param ref - expected current revision.
   * @returns the completed view.
   */
  complete(agent: Agent, ref: ConductorRef): ConductorView {
    return this.transition(agent, ref, 'complete', ['active', 'paused', 'blocked'], 'complete', 'disarmed')
  }

  /**
   * Mark an active board blocked and disarm it.
   * @param agent - owning live agent (the current conductor).
   * @param ref - expected current revision.
   * @param reason - policy-owned stable code and human-readable explanation.
   * @returns the blocked view with its durable reason.
   */
  block(agent: Agent, ref: ConductorRef, reason: TaskBlockReason): ConductorView {
    const cache = this.prepareMutation(agent)
    const current = this.expectCurrent(cache, ref)
    this.requireConductor(agent, current)
    if (current.phase !== 'active') {
      throw this.transitionError(current, 'block', ['active'])
    }
    return this.commitCurrent(
      agent,
      cache,
      'block',
      { ...this.withPhase(current, 'blocked'), blockedReason: resolveBlockReason(reason) },
      'disarmed',
    )
  }

  /**
   * Clear the current board while retaining a durable tombstone and history.
   * @param agent - owning live agent (the current conductor).
   * @param ref - expected current revision.
   * @returns the tombstone ref whose revision is one past the cleared snapshot.
   */
  clear(agent: Agent, ref: ConductorRef): ConductorRef {
    const cache = this.prepareMutation(agent)
    const current = this.expectCurrent(cache, ref)
    this.requireConductor(agent, current)
    const tombstone: ConductorRef = { id: current.id, revision: current.revision + 1 }
    const change: ConductorClearChangeMeta = {
      kind: 'conductor/change',
      version: CONDUCTOR_CHANGE_VERSION,
      operation: 'clear',
      cleared: tombstone,
      clearedAt: this.nextMutationTime(cache),
    }
    this.commit(agent, cache, change, 'disarmed')
    return { ...tombstone }
  }

  /**
   * Add one task to the board. Dependencies must name existing task ids and
   * must not create a cycle.
   * @param agent - owning live agent (the current conductor).
   * @param ref - expected current revision.
   * @param request - title, description, and optional existing-task dependencies.
   * @returns the updated view.
   */
  createTask(agent: Agent, ref: ConductorRef, request: CreateTaskRequest): ConductorView {
    const cache = this.prepareMutation(agent)
    const current = this.expectCurrent(cache, ref)
    this.requireConductor(agent, current)
    const dependsOn = this.resolveDependencies(current, request.dependsOn ?? [])
    const task: TaskSnapshot = {
      id: brandTaskId(`task-${randomUUID()}`),
      title: resolveObjective(request.title),
      description: resolveObjective(request.description),
      status: 'todo',
      dependsOn,
      reports: [],
    }
    const board: ConductorSnapshot = {
      ...current,
      revision: current.revision + 1,
      tasks: [...current.tasks, task],
    }
    return this.commitCurrent(agent, cache, 'task-create', board, cache.activation)
  }

  /**
   * Edit one task's title, description, or dependencies without changing its
   * status or reports.
   * @param agent - owning live agent (the current conductor).
   * @param ref - expected current revision.
   * @param taskId - the task to edit.
   * @param request - at least one replacement field.
   * @returns the updated view.
   */
  editTask(agent: Agent, ref: ConductorRef, taskId: TaskId, request: EditTaskRequest): ConductorView {
    const cache = this.prepareMutation(agent)
    const current = this.expectCurrent(cache, ref)
    this.requireConductor(agent, current)
    const task = this.expectTask(current, taskId)
    if (request.title === undefined && request.description === undefined && request.dependsOn === undefined) {
      throw new ConductorError('conductor task edit requires title, description, and/or dependsOn', 'CONDUCTOR_INVALID_EDIT')
    }
    const dependsOn = request.dependsOn === undefined
      ? task.dependsOn
      : this.resolveDependencies(current, request.dependsOn, taskId)
    const title = request.title === undefined ? task.title : resolveObjective(request.title)
    const description = request.description === undefined
      ? task.description
      : resolveObjective(request.description)
    const dependenciesChanged = dependsOn.length !== task.dependsOn.length
      || dependsOn.some((dependency, index) => dependency !== task.dependsOn[index])
    if (title === task.title && description === task.description && !dependenciesChanged) {
      throw new ConductorError('conductor task edit must change the task', 'CONDUCTOR_INVALID_EDIT')
    }
    const edited: TaskSnapshot = {
      ...task,
      title,
      description,
      dependsOn,
    }
    const board: ConductorSnapshot = {
      ...current,
      revision: current.revision + 1,
      tasks: current.tasks.map(candidate => candidate.id === taskId ? edited : candidate),
    }
    return this.commitCurrent(agent, cache, 'task-edit', board, cache.activation)
  }

  /**
   * Set one task's status. Blocking requires a reason; leaving the done
   * status is rejected.
   * @param agent - owning live agent (the current conductor).
   * @param ref - expected current revision.
   * @param taskId - the task to update.
   * @param status - the target status.
   * @param reason - required exactly when `status` is `blocked`.
   * @returns the updated view.
   */
  setTaskStatus(agent: Agent, ref: ConductorRef, taskId: TaskId, status: TaskStatus, reason?: unknown): ConductorView {
    const cache = this.prepareMutation(agent)
    const current = this.expectCurrent(cache, ref)
    this.requireConductor(agent, current)
    const task = this.expectTask(current, taskId)
    if (task.status === status) {
      throw new ConductorError(`task "${taskId}" already has status "${status}"`, 'CONDUCTOR_INVALID_TASK')
    }
    if (task.status === 'done' && status !== 'done') {
      throw new ConductorError('a done task cannot leave the done status', 'CONDUCTOR_INVALID_TASK')
    }
    if (status === 'blocked' && reason === undefined) {
      throw new ConductorError('blocking a task requires a reason', 'CONDUCTOR_INVALID_BLOCK_REASON')
    }
    const { blockedReason: _existing, ...taskRest } = task
    const edited: TaskSnapshot = {
      ...taskRest,
      status,
      ...status === 'blocked' ? { blockedReason: resolveBlockReason(reason) } : {},
    }
    const board: ConductorSnapshot = {
      ...current,
      revision: current.revision + 1,
      tasks: current.tasks.map(candidate => candidate.id === taskId ? edited : candidate),
    }
    return this.commitCurrent(agent, cache, 'task-status', board, cache.activation)
  }

  /**
   * Return one task to the todo status without an assignee so the scheduler
   * assigns a fresh worker window. Prior reports are retained for the next
   * worker's briefing. A done task cannot be reassigned.
   * @param agent - owning live agent (the current conductor).
   * @param ref - expected current revision.
   * @param taskId - the task to reassign.
   * @returns the updated view.
   */
  reassignTask(agent: Agent, ref: ConductorRef, taskId: TaskId): ConductorView {
    const cache = this.prepareMutation(agent)
    const current = this.expectCurrent(cache, ref)
    this.requireConductor(agent, current)
    const task = this.expectTask(current, taskId)
    if (task.status === 'done') {
      throw new ConductorError('a done task cannot be reassigned', 'CONDUCTOR_INVALID_TASK')
    }
    if (task.status === 'todo' && task.assignee === undefined) {
      throw new ConductorError(`task "${taskId}" is already an unassigned todo`, 'CONDUCTOR_INVALID_TASK')
    }
    const { assignee: _drop, blockedReason: _dropReason, ...taskRest } = task
    const edited: TaskSnapshot = {
      ...taskRest,
      status: 'todo',
    }
    const board: ConductorSnapshot = {
      ...current,
      revision: current.revision + 1,
      tasks: current.tasks.map(candidate => candidate.id === taskId ? edited : candidate),
    }
    return this.commitCurrent(agent, cache, 'task-assign', board, cache.activation)
  }

  /**
   * Receive a worker's report about its assigned task: validate the worker,
   * commit the report into the current conductor's board, and deliver the
   * framed report message to the current conductor window.
   * @param worker - exact live reporting worker agent.
   * @param request - task id, claimed status, and self-contained message.
   * @returns the accepted report delivery's message id.
   * @throws {@link ConductorError} when the worker is not the task's assignee,
   *   the task is already done, or no live current conductor exists.
   */
  report(worker: Agent, request: TaskReportRequest): ReportResult {
    this.assertLive(worker)
    const { session: conductorSession, view: boardView } = this.resolveCurrentBoard(worker)
    const task = boardView.tasks.find(candidate => candidate.id === request.taskId)
    if (task === undefined) {
      throw new ConductorError(`task "${request.taskId}" does not exist in the current board`, 'CONDUCTOR_TASK_NOT_FOUND')
    }
    if (task.assignee !== worker.session.id) {
      throw new ConductorError(
        `worker "${worker.session.id}" is not the assignee of task "${request.taskId}"`,
        'CONDUCTOR_WORKER_NOT_ASSIGNED',
      )
    }
    if (task.status === 'done') {
      throw new ConductorError(`task "${request.taskId}" is already done`, 'CONDUCTOR_INVALID_REPORT')
    }
    const message = typeof request.message === 'string' ? request.message.trim() : ''
    if (message.length === 0) {
      throw new ConductorError('a task report requires a non-empty message', 'CONDUCTOR_INVALID_REPORT')
    }
    const conductorAgent = ctxAgent(this.ctx, conductorSession.id)
    if (conductorAgent === undefined) {
      throw new ConductorError(
        `the current conductor session "${conductorSession.id}" is not live`,
        'CONDUCTOR_CONDUCTOR_NOT_LIVE',
      )
    }
    const reportedStatus = request.status
    const workerCompactions = this.compactionCount(worker.session)
    const report: TaskReportEntry = {
      status: reportedStatus,
      message,
      at: Date.now(),
      workerSessionId: worker.session.id,
      workerCompactions,
    }
    /* v8 ignore start -- an assigned task is never todo: assignment marks it in-progress */
    const nextStatus: TaskStatus = reportedStatus === 'done'
      ? 'done'
      : reportedStatus === 'blocked'
        ? 'blocked'
        : task.status === 'todo' ? 'in-progress' : task.status
    /* v8 ignore stop */
    const { blockedReason: _existing, ...taskRest } = task
    const edited: TaskSnapshot = {
      ...taskRest,
      status: nextStatus,
      ...nextStatus === 'blocked'
        ? { blockedReason: { code: 'worker-blocked', message } }
        : {},
      reports: [...task.reports, report].slice(-this.resolved.reportHistoryLimit),
    }
    const {
      createdAt: _viewCreatedAt,
      updatedAt: _viewUpdatedAt,
      activation: _viewActivation,
      compactionCount: _viewCompactions,
      ...boardSnapshot
    } = boardView
    const boardNext: ConductorSnapshot = {
      ...boardSnapshot,
      revision: boardSnapshot.revision + 1,
      tasks: boardSnapshot.tasks.map(candidate => candidate.id === request.taskId ? edited : candidate),
    }
    const cache = this.cache(conductorSession)
    this.sync(conductorSession, cache)
    this.commitToSession(
      conductorSession,
      cache,
      'task-report',
      boardNext,
      boardView.createdAt,
      Math.max(Date.now(), boardView.updatedAt),
      cache.activation,
    )
    const content = renderReportMessage(edited, reportedStatus, message, workerCompactions, worker.session.id)
    const delivered = createUserMessage({
      content: [{ type: 'text', text: content }],
      source: { kind: 'conductor-report', form: 'relay', senderSessionId: worker.session.id },
    })
    conductorAgent.followup(delivered)
    return { messageId: delivered.id }
  }

  /**
   * Deliver one message from the current conductor to one of its workers.
   * Cold-resumes the worker through the subagent service when the conductor
   * is the worker's durable direct parent; otherwise the worker agent must be
   * live.
   * @param agent - owning live agent (the current conductor).
   * @param workerSessionId - the worker session to deliver to.
   * @param text - the message content.
   * @returns the accepted delivery's message id.
   */
  async deliver(agent: Agent, workerSessionId: SessionId, text: string): Promise<DeliverResult> {
    this.assertLive(agent)
    const cache = this.prepareMutation(agent)
    const current = this.expectCurrent(cache, undefined)
    this.requireConductor(agent, current)
    const message = typeof text === 'string' ? text.trim() : ''
    if (message.length === 0) {
      throw new ConductorError('a conductor message requires non-empty text', 'CONDUCTOR_INVALID_REPORT')
    }
    const assigned = current.tasks.some(task => task.assignee === workerSessionId)
    if (!assigned) {
      throw new ConductorError(
        `session "${workerSessionId}" is not assigned to any task of this board`,
        'CONDUCTOR_WORKER_NOT_FOUND',
      )
    }
    const content: ContentBlock[] = [{ type: 'text', text: message }]
    const source = { kind: 'conductor' as const, form: 'relay' as const, senderSessionId: agent.session.id }
    const live = ctxAgent(this.ctx, workerSessionId)
    if (live !== undefined) {
      const delivered = createUserMessage({ content, source })
      live.followup(delivered)
      return { messageId: delivered.id }
    }
    const parent = ctxSession(this.ctx, workerSessionId)?.header.parentSession
    if (parent !== agent.session.id) {
      throw new ConductorError(
        `worker session "${workerSessionId}" is not live and cannot be cold-resumed`,
        'CONDUCTOR_WORKER_NOT_FOUND',
      )
    }
    const messageId = await this.ctx.subagents.followup(
      agent,
      workerSessionId,
      content,
      { source, signal: new AbortController().signal },
    )
    return { messageId }
  }

  /**
   * Hand the conductor role to a fresh window: create a continuable child,
   * transfer the full board snapshot into its log, and retire this window.
   * The same change payload commits to both sessions, so each side's log
   * reconstructs the same post-handover board.
   * @param agent - owning live agent (the current conductor).
   * @param reason - why the window is handing over.
   * @returns the successor window's session id and briefing message id.
   */
  async handover(agent: Agent, reason: string): Promise<HandoverResult> {
    this.assertLive(agent)
    const cache = this.prepareMutation(agent)
    const current = this.expectCurrent(cache, undefined)
    this.requireConductor(agent, current)
    const normalized = typeof reason === 'string' ? reason.trim() : ''
    if (normalized.length === 0) {
      throw new ConductorError('a conductor handover requires a reason', 'CONDUCTOR_INVALID_HANDOVER')
    }
    if (current.phase !== 'active') {
      throw this.transitionError(current, 'handover', ['active'])
    }
    const view = this.view(agent.session, cache)
    /* v8 ignore next -- expectCurrent guaranteed a current board, so the view exists */
    if (view === undefined) throw new Error('current conductor board lacks a view')
    const briefing = renderHandoverBriefing(view, normalized, this.compactionCount(agent.session))
    const started = await this.startChild(agent, {
      provider: this.resolved.handoverProvider,
      label: 'conductor-handover',
      prompt: [{ type: 'text', text: briefing }],
      persona: undefined,
      toolFilter: undefined,
    })
    // Worker reports and explicit board controls can commit while the child
    // startup is awaiting inbox acceptance. Rebase the handover on the exact
    // latest board before either session receives the transfer.
    this.sync(agent.session, cache)
    const latest = this.expectCurrent(cache, undefined)
    this.requireConductor(agent, latest)
    if (latest.phase !== 'active') {
      throw this.transitionError(latest, 'handover', ['active'])
    }
    const latestView = this.view(agent.session, cache)
    /* v8 ignore next -- expectCurrent guaranteed a current board, so the view exists */
    if (latestView === undefined) throw new Error('current conductor board lacks a view after handover startup')
    const successor = ctxSession(this.ctx, started.childId)
    if (successor === undefined) {
      throw new ConductorError(
        `handover child "${started.childId}" is not live in the session store`,
        'CONDUCTOR_INVALID_HANDOVER',
      )
    }
    const now = Math.max(Date.now(), latestView.updatedAt)
    const transferred: ConductorSnapshot = {
      ...latest,
      revision: latest.revision + 1,
      conductorSessionId: started.childId,
      handoverCount: latest.handoverCount + 1,
    }
    // The successor installs the transferred board from an empty fold and
    // arms it; the retiring session transitions to the same snapshot and
    // disarms. Both logs carry the identical payload.
    const successorCache = this.cache(successor)
    this.sync(successor, successorCache)
    // Retire the current authority first. The successor append is built from
    // already-decoded state and cannot race another board writer in this
    // synchronous section, so no two armed conductors are published.
    this.commitToSession(agent.session, cache, 'handover', transferred, latestView.createdAt, now, 'disarmed')
    this.commitToSession(successor, successorCache, 'handover', transferred, latestView.createdAt, now, 'armed')
    return { childId: started.childId, messageId: started.messageId }
  }

  /**
   * Spawn worker windows for the currently ready tasks, honoring the board's
   * scheduling mode: the first ready task in serial mode, ready tasks up to
   * the parallel cap otherwise. Tasks whose dependencies are blocked are
   * marked blocked first.
   * @param agent - owning live agent (the current conductor).
   * @returns the spawned worker identities in assignment order.
   * @throws {@link ConductorError} when the board is not active and armed or a spawn fails.
   */
  async spawnWorkers(agent: Agent): Promise<SpawnedWorker[]> {
    this.assertLive(agent)
    const cache = this.prepareMutation(agent)
    const current = this.expectCurrent(cache, undefined)
    this.requireConductor(agent, current)
    if (current.phase !== 'active' || cache.activation !== 'armed') {
      throw new ConductorError(
        `board "${current.id}" is not active and armed; cannot schedule workers`,
        'CONDUCTOR_INVALID_TRANSITION',
      )
    }
    // Mark tasks whose dependencies are blocked before planning the ready set.
    const initialPlan = planScheduling(current)
    for (const task of initialPlan.dependencyBlocked) {
      const latest = this.currentBoard(cache)
      const edited: TaskSnapshot = {
        ...task,
        status: 'blocked',
        blockedReason: {
          code: 'dependency-blocked',
          message: 'a dependency of this task is blocked',
        },
      }
      const board: ConductorSnapshot = {
        ...latest,
        revision: latest.revision + 1,
        tasks: latest.tasks.map(candidate => candidate.id === task.id ? edited : candidate),
      }
      this.commitCurrent(agent, cache, 'task-status', board, cache.activation)
    }
    // Recompute the ready set after the blocking pass and plan the spawns.
    const freshView = this.view(agent.session, cache)
    /* v8 ignore next -- the blocking pass commits kept a current board */
    if (freshView === undefined) throw new Error('current conductor board lacks a view')
    const plan = planScheduling(freshView)
    const starts = planWorkerStarts(freshView, plan, freshView.maxParallelWorkers)
    const spawned: SpawnedWorker[] = []
    for (const task of starts) {
      const briefing = renderWorkerPrompt(freshView, task, agent.session.header.cwd)
      let started: ContinuableStart
      try {
        started = await this.startChild(agent, {
          provider: this.resolved.workerProvider,
          label: task.title,
          prompt: [{ type: 'text', text: briefing }],
          persona: this.resolved.workerPersona,
          toolFilter: this.resolved.workerToolFilter,
        })
      } catch (error: unknown) {
        throw new ConductorError(
          `could not spawn a worker for task "${task.id}": ${error instanceof Error ? error.message : String(error)}`,
          'CONDUCTOR_SPAWN_FAILED',
        )
      }
      const latest = this.currentBoard(cache)
      const assigned: TaskSnapshot = {
        ...task,
        status: 'in-progress',
        assignee: started.childId,
      }
      const board: ConductorSnapshot = {
        ...latest,
        revision: latest.revision + 1,
        tasks: latest.tasks.map(candidate => candidate.id === task.id ? assigned : candidate),
      }
      this.commitCurrent(agent, cache, 'task-assign', board, cache.activation)
      // Name the worker window by its task so the sidebar shows what it is
      // responsible for. A title write is cosmetic: a failing or missing
      // session-title service never blocks scheduling.
      try {
        const childSession = ctxSession(this.ctx, started.childId)
        if (this.title !== undefined && childSession !== undefined) {
          this.title.rename(childSession, task.title)
        }
      } catch (error: unknown) {
        this.ctx.logger.warn(`conductor: could not title worker "${started.childId}": ${error instanceof Error ? error.message : String(error)}`)
      }
      spawned.push({ taskId: task.id, workerId: started.childId, messageId: started.messageId })
    }
    return spawned
  }

  /**
   * Count the context compactions a session has undergone.
   * @param session - the session to count.
   * @returns the number of `compaction/summary` events in its log.
   */
  compactionCount(session: Session): number {
    let count = 0
    for (const event of session.events) {
      if (event.type === 'compaction/summary') count += 1
    }
    return count
  }

  /** Start one continuable child with the resolved worker composition. */
  private async startChild(
    parent: Agent,
    spec: {
      readonly provider: string
      readonly label: string
      readonly prompt: ContentBlock[]
      readonly persona: string | undefined
      readonly toolFilter: ToolRestriction | undefined
    },
  ): Promise<ContinuableStart> {
    const request: Omit<SubagentStartRequest, 'label' | 'signal' | 'outputSchema'> = {
      parent,
      prompt: spec.prompt,
      ...spec.persona !== undefined ? { persona: spec.persona } : {},
      ...spec.toolFilter !== undefined ? { toolFilter: spec.toolFilter } : {},
    }
    return this.ctx.subagents.startContinuable({
      provider: spec.provider,
      label: spec.label,
      request,
      signal: new AbortController().signal,
    })
  }

  /** Resolve and validate the cache used by a mutation. */
  private prepareMutation(agent: Agent): ConductorCache {
    this.assertLive(agent)
    const cache = this.cache(agent.session)
    this.sync(agent.session, cache)
    return cache
  }

  /** Reject stale or missing current-state refs. */
  private expectCurrent(cache: ConductorCache, ref: ConductorRef | undefined): ConductorSnapshot {
    const current = cache.state.board
    if (current === undefined) throw new ConductorError('no current board', 'CONDUCTOR_NOT_FOUND')
    if (ref !== undefined && (ref.id !== current.id || ref.revision !== current.revision)) {
      throw new ConductorError(
        `stale board ref "${ref.id}" revision ${ref.revision}; current is "${current.id}" revision ${current.revision}`,
        'CONDUCTOR_STALE_REVISION',
      )
    }
    return current
  }

  /** Read the current board snapshot after a sync. */
  private currentBoard(cache: ConductorCache): ConductorSnapshot {
    const board = cache.state.board
    /* v8 ignore next 2 -- every caller read the current board through expectCurrent immediately before */
    if (board === undefined) throw new ConductorError('no current board', 'CONDUCTOR_NOT_FOUND')
    return board
  }

  /** Enforce exact live-agent identity rather than trusting a matching id. */
  private assertLive(agent: Agent): void {
    if (this.ctx.agents.get(agent.id) !== agent) {
      throw new ConductorError(`agent "${agent.id}" is not live in this registry`, 'CONDUCTOR_AGENT_NOT_LIVE')
    }
  }

  /** Enforce that the caller is a top-level session, not a delegated worker. */
  private assertTopLevel(agent: Agent): void {
    if (agent.session.header.delegationDepth !== undefined
      || agent.session.header.origin === 'subagent') {
      throw new ConductorError(
        `session "${agent.session.id}" is a delegated worker and cannot become a conductor`,
        'CONDUCTOR_NOT_TOP_LEVEL',
      )
    }
  }

  /** Enforce that the caller's session is the board's current conductor. */
  private requireConductor(agent: Agent, board: ConductorSnapshot): void {
    if (board.conductorSessionId !== agent.session.id) {
      throw new ConductorError(
        `session "${agent.session.id}" is not the current conductor; the board moved to "${board.conductorSessionId}"`,
        'CONDUCTOR_NOT_CONDUCTOR',
      )
    }
  }

  /** Return the live current-conductor board a worker's report routes to. */
  private resolveCurrentBoard(worker: Agent): { readonly session: Session; readonly view: ConductorView } {
    let current: Session | undefined = worker.session
    for (let hops = 0; hops < 64; hops += 1) {
      if (current === undefined) break
      const cache = this.cache(current)
      this.sync(current, cache)
      const board = cache.state.board
      if (board === undefined) {
        const parentSession = current.header.parentSession
        if (parentSession === undefined) {
          current = undefined
          continue
        }
        current = ctxSession(this.ctx, parentSession)
        continue
      }
      if (board.conductorSessionId === current.id) {
        const view = this.view(current, cache)
        /* v8 ignore start -- strict replay and every committed snapshot make the view exist */
        if (view !== undefined) return { session: current, view }
        break
        /* v8 ignore stop */
      }
      current = ctxSession(this.ctx, board.conductorSessionId)
    }
    throw new ConductorError(
      `no live current conductor found for worker "${worker.session.id}"`,
      'CONDUCTOR_CONDUCTOR_NOT_LIVE',
    )
  }

  /** Validate and detach one task's dependency list. */
  private resolveDependencies(
    board: ConductorSnapshot,
    dependsOn: readonly TaskId[],
    selfId?: TaskId,
  ): readonly TaskId[] {
    const seen = new Set<TaskId>()
    for (const dep of dependsOn) {
      if (typeof dep !== 'string' || dep.length === 0) {
        throw new ConductorError('task dependencies must be non-empty task ids', 'CONDUCTOR_TASK_DEPENDENCY')
      }
      if (dep === selfId) {
        throw new ConductorError('a task cannot depend on itself', 'CONDUCTOR_TASK_DEPENDENCY')
      }
      if (seen.has(dep)) {
        throw new ConductorError(`duplicate dependency "${dep}"`, 'CONDUCTOR_TASK_DEPENDENCY')
      }
      seen.add(dep)
    }
    const byId = new Map(board.tasks.map(task => [task.id, task]))
    for (const dep of seen) {
      if (!byId.has(dep)) {
        throw new ConductorError(
          `dependency "${dep}" does not name an existing task`,
          'CONDUCTOR_TASK_DEPENDENCY',
        )
      }
    }
    if (selfId !== undefined) {
      // The edited task's new dependencies must not make it reachable from
      // itself: follow the graph starting at each new dependency.
      const visiting = new Set<TaskId>()
      const visited = new Set<TaskId>()
      const visit = (id: TaskId): void => {
        if (id === selfId) {
          throw new ConductorError('task dependencies must not create a cycle', 'CONDUCTOR_TASK_DEPENDENCY')
        }
        if (visited.has(id)) return
        /* v8 ignore next 4 -- the decoded board is acyclic, so a dependency graph walk never revisits an in-flight node */
        if (visiting.has(id)) {
          throw new ConductorError('task dependencies must not create a cycle', 'CONDUCTOR_TASK_DEPENDENCY')
        }
        visiting.add(id)
        const task = byId.get(id)
        /* v8 ignore next 3 -- every visited id is a validated dependency present in the board map */
        if (task !== undefined) {
          for (const dep of task.dependsOn) visit(dep)
        }
        visiting.delete(id)
        visited.add(id)
      }
      for (const dep of seen) visit(dep)
    }
    return [...seen]
  }

  /** Find one task of the current board. */
  private expectTask(board: ConductorSnapshot, taskId: TaskId): TaskSnapshot {
    const task = board.tasks.find(candidate => candidate.id === taskId)
    if (task === undefined) {
      throw new ConductorError(`task "${taskId}" does not exist in the board`, 'CONDUCTOR_TASK_NOT_FOUND')
    }
    return task
  }

  /** Return the per-session cache, folding a seed once with activation disarmed. */
  private cache(session: Session): ConductorCache {
    let cache = this.caches.get(session)
    if (cache !== undefined) return cache
    const state = emptyConductorFoldState()
    for (const event of session.events) applyConductorEvent(state, event)
    cache = {
      state,
      activation: 'disarmed',
      observedSeq: session.seq,
      pendingActivation: undefined,
    }
    this.caches.set(session, cache)
    return cache
  }

  /** Incrementally observe durable events and reconcile local activation intent. */
  private sync(session: Session, cache: ConductorCache): void {
    for (const event of session.events.slice(cache.observedSeq)) {
      if (event.type === 'conductor/change') {
        applyConductorEvent(cache.state, event)
        /* v8 ignore next 3 -- every observed change was appended by this service's commit with a matching pending activation */
        cache.activation = cache.pendingActivation?.seq === event.seq
          ? cache.pendingActivation.activation
          : 'disarmed'
      }
      cache.observedSeq += 1
    }
  }

  /** Build a new revision with one replacement phase. */
  private withPhase(current: ConductorSnapshot, phase: ConductorSnapshot['phase']): ConductorSnapshot {
    const { blockedReason: _existing, ...rest } = current
    return {
      ...rest,
      revision: current.revision + 1,
      phase,
    }
  }

  /** Shared validated phase transition. */
  private transition(
    agent: Agent,
    ref: ConductorRef,
    operation: 'pause' | 'resume' | 'complete',
    allowed: readonly ConductorSnapshot['phase'][],
    phase: ConductorSnapshot['phase'],
    activation: ConductorActivation,
  ): ConductorView {
    const cache = this.prepareMutation(agent)
    const current = this.expectCurrent(cache, ref)
    this.requireConductor(agent, current)
    if (!allowed.includes(current.phase)) throw this.transitionError(current, operation, allowed)
    return this.commitCurrent(agent, cache, operation, this.withPhase(current, phase), activation)
  }

  /** Render a stable invalid-transition error. */
  private transitionError(
    current: ConductorSnapshot,
    operation: ConductorOperation,
    allowed: readonly ConductorSnapshot['phase'][],
  ): ConductorError {
    return new ConductorError(
      `cannot ${operation} board "${current.id}" from phase "${current.phase}"; expected ${allowed.join(' or ')}`,
      'CONDUCTOR_INVALID_TRANSITION',
    )
  }

  /** Commit a mutation that retains the current board's derived timestamps. */
  private commitCurrent(
    agent: Agent,
    cache: ConductorCache,
    operation: Exclude<ConductorOperation, 'init' | 'clear' | 'handover'>,
    board: ConductorSnapshot,
    activation: ConductorActivation,
  ): ConductorView {
    const createdAt = cache.state.createdAt
    /* v8 ignore next -- strict replay and every snapshot commit set createdAt whenever a current board exists */
    if (createdAt === undefined) throw new Error('current conductor cache lacks createdAt')
    return this.commitSnapshot(
      agent,
      cache,
      operation,
      board,
      createdAt,
      this.nextMutationTime(cache),
      activation,
    )
  }

  /** Clamp a current board's next timestamp across backward wall-clock movement. */
  private nextMutationTime(cache: ConductorCache): number {
    const updatedAt = cache.state.updatedAt
    /* v8 ignore next -- strict replay and every snapshot commit set updatedAt whenever a current board exists */
    if (updatedAt === undefined) throw new Error('current conductor cache lacks updatedAt')
    return Math.max(Date.now(), updatedAt)
  }

  /** Build and commit one full-snapshot mutation on the owning agent's session. */
  private commitSnapshot(
    agent: Agent,
    cache: ConductorCache,
    operation: Exclude<ConductorOperation, 'clear'>,
    board: ConductorSnapshot,
    createdAt: number,
    updatedAt: number,
    activation: ConductorActivation,
  ): ConductorView {
    const change: ConductorSnapshotChangeMeta = {
      kind: 'conductor/change',
      version: CONDUCTOR_CHANGE_VERSION,
      operation,
      board,
      createdAt,
      updatedAt,
    }
    this.commit(agent, cache, change, activation)
    const view = this.view(agent.session, cache)
    /* v8 ignore next -- the durable board event installs the snapshot before this read */
    if (view === undefined) throw new Error('snapshot commit cleared the board unexpectedly')
    return view
  }

  /** Commit one mutation into the caller's session log, cache, and live event stream. */
  private commit(agent: Agent, cache: ConductorCache, change: ConductorChangeMeta, activation: ConductorActivation): void {
    const ref = conductorChangeRef(change)
    cache.pendingActivation = { seq: agent.session.seq, activation }
    try {
      agent.session.append('conductor/change', change)
      this.sync(agent.session, cache)
    } finally {
      cache.pendingActivation = undefined
    }
    const board = this.view(agent.session, cache)
    const notification: ConductorChanged = {
      operation: change.operation,
      ref: { ...ref },
      ...board === undefined ? {} : { board },
    }
    agentEvents(this.ctx, agent).emit('conductor/changed', { change: notification })
  }

  /** Commit one mutation into an arbitrary live session's log, cache, and stream. */
  private commitToSession(
    session: Session,
    cache: ConductorCache,
    operation: Exclude<ConductorOperation, 'clear'>,
    board: ConductorSnapshot,
    createdAt: number,
    updatedAt: number,
    activation: ConductorActivation,
  ): void {
    const change: ConductorSnapshotChangeMeta = {
      kind: 'conductor/change',
      version: CONDUCTOR_CHANGE_VERSION,
      operation,
      board,
      createdAt,
      updatedAt,
    }
    const ref = conductorChangeRef(change)
    cache.pendingActivation = { seq: session.seq, activation }
    try {
      session.append('conductor/change', change)
      this.sync(session, cache)
    } finally {
      cache.pendingActivation = undefined
    }
    const agent = ctxAgent(this.ctx, session.id)
    /* v8 ignore next -- the caller validated a live agent before committing to this session */
    if (agent === undefined) return
    const boardView = this.view(session, cache)
    const notification: ConductorChanged = {
      operation,
      ref: { ...ref },
      /* v8 ignore next -- the committed snapshot makes the view exist */
      ...boardView === undefined ? {} : { board: boardView },
    }
    agentEvents(this.ctx, agent).emit('conductor/changed', { change: notification })
  }

  /** Build a detached current view. */
  private view(session: Session, cache: ConductorCache): ConductorView | undefined {
    const board = cache.state.board
    const createdAt = cache.state.createdAt
    const updatedAt = cache.state.updatedAt
    if (board === undefined) return undefined
    /* v8 ignore next 3 -- strict replay and snapshot commits establish both timestamps with every current board */
    if (createdAt === undefined || updatedAt === undefined) {
      throw new Error(`board "${board.id}" cache lacks timestamps`)
    }
    return {
      ...board,
      createdAt,
      updatedAt,
      activation: cache.activation,
      compactionCount: this.compactionCount(session),
    }
  }
}

export default ConductorService

/** Resolve one live agent by session id. */
function ctxAgent(ctx: Context, sessionId: SessionId): Agent | undefined {
  return ctx.agents.get(sessionId)
}

/** Resolve one live session by id. */
function ctxSession(ctx: Context, sessionId: SessionId): Session | undefined {
  return ctx.sessions.get(sessionId)
}
