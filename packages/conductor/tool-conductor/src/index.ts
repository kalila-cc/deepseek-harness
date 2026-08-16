/**
 * Model-facing conductor tools: board init, task decomposition, status
 * tracking, scheduling, worker messaging, and role handover over the
 * persisted conductor domain.
 * @module @deepseek-ai/dsh-tool-conductor
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ConductorError, TaskId, conductorToolExecution } from '@deepseek-ai/dsh-conductor'
import type { ConductorRef, ConductorView, TaskReportStatus } from '@deepseek-ai/dsh-conductor'
import type { TaskId as TaskIdType } from '@deepseek-ai/dsh-conductor/types'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { SessionId } from '@deepseek-ai/dsh-session/types'

export const name = 'tool-conductor'
export const inject = ['agents', 'conductor', 'tools', 'systemPrompt']

/** Model policy for worker handover thresholds. */
export interface Config {
  /** Worker compaction count at which the conductor should reassign the task to a fresh window. */
  workerHandoverAfterCompactions?: number
}

/** Schemastery config for the conductor-tool policy. */
export const Config: z<Config> = z.object({
  workerHandoverAfterCompactions: z.number().step(1).min(1).default(4),
})

/** Fully materialized tool policy. */
interface ResolvedConfig {
  readonly workerHandoverAfterCompactions: number
}

/** Guidance order after every per-tool section a conductor window can carry. */
const CONDUCTOR_SECTION_ORDER = 118

const INIT_DESCRIPTION =
  'Create the conductor task board for a user-described objective: the calling top-level session '
  + 'becomes the conductor window. Analyze the objective, decompose it into subtasks with '
  + 'dependencies, and write the implementation plan outline. mode "serial" runs one worker at a time '
  + '(stable, token-economical); mode "parallel" runs ready workers concurrently. Omit mode to honor '
  + 'the user\'s saved scheduling preference; pass it only when the user explicitly requests an override. '
  + 'Scheduling starts automatically once tasks exist.'

const TASK_BOARD_DESCRIPTION =
  'Read the current conductor task board: objective, plan outline, mode, phase, conductor session id, '
  + 'handover count, activation, this session\'s compaction count, and every task with its status, '
  + 'dependencies, assignee, and report history. Call this before updating the board or a task, and '
  + 'after every worker report wakes you. Do not poll it while workers are in progress; end your turn and '
  + 'let their reports wake you.'

const TASK_CREATE_DESCRIPTION =
  'Add tasks to the conductor board. Each task must have a short imperative title and a self-contained '
  + 'description a worker can execute without further context. depends_on names existing task ids that '
  + 'must reach done before this task may start; use it to express the dependency order you derived from '
  + 'the objective. Scheduling starts automatically once tasks exist.'

const TASK_UPDATE_DESCRIPTION =
  'Update one task\'s status: start (in-progress), done, blocked (reason required), unblock (back to '
  + 'todo), or reassign (back to todo without assignee so the scheduler assigns a fresh worker window; '
  + 'prior reports stay in the briefing).'

const CONDUCTOR_UPDATE_DESCRIPTION =
  'Update the board itself: edit (objective and/or plan_outline), set_mode (mode and/or '
  + 'max_parallel_workers), pause, resume, complete, or block (reason required).'

const TASK_SCHEDULE_DESCRIPTION =
  'Trigger one scheduling pass now: mark dependency-blocked tasks blocked, then spawn worker windows '
  + 'for the ready tasks per the board mode (serial: one; parallel: up to the cap). Scheduling also runs '
  + 'automatically whenever the board is active and the conductor window is idle, so use this only to '
  + 'force a pass before the next automatic one.'

const CONDUCTOR_MESSAGE_DESCRIPTION =
  'Send a message from the conductor to one worker window by its session id (the assignee of a task in '
  + 'this board). The message becomes the worker\'s next turn. Returns no answer — only confirmation of '
  + 'delivery.'

const CONDUCTOR_HANDOVER_DESCRIPTION =
  'Hand the conductor role to a fresh window: a new continuable session receives the full board snapshot '
  + 'and a briefing, and this window retires. Use it when this session has been compacted too many times '
  + 'to keep output quality high; the round driver also hands over automatically at the threshold. '
  + 'Announce the new window to the user.'

/** Compact model result for one board view. */
type ConductorToolValue =
  | { board: null }
  | {
    board: {
      id: string
      revision: number
      objective: string
      planOutline: string
      mode: 'serial' | 'parallel'
      maxParallelWorkers: number
      phase: ConductorView['phase']
      blockedReason?: { code: string; message: string }
      conductorSessionId: string
      handoverCount: number
      tasks: Array<{
        id: string
        title: string
        description: string
        status: ConductorView['tasks'][number]['status']
        dependsOn: string[]
        assignee?: string
        blockedReason?: { code: string; message: string }
        reports: Array<{
          status: TaskReportStatus
          message: string
          at: number
          workerSessionId: string
          workerCompactions: number
        }>
      }>
    }
    createdAt: number
    updatedAt: number
    activation: ConductorView['activation']
    compactionCount: number
  }

/** Build the canonical tool value from a view. */
function conductorValue(view: ConductorView | undefined): ConductorToolValue {
  if (view === undefined) return { board: null }
  return {
    board: {
      id: view.id,
      revision: view.revision,
      objective: view.objective,
      planOutline: view.planOutline,
      mode: view.mode,
      maxParallelWorkers: view.maxParallelWorkers,
      phase: view.phase,
      ...view.blockedReason === undefined ? {} : { blockedReason: view.blockedReason },
      conductorSessionId: view.conductorSessionId,
      handoverCount: view.handoverCount,
      tasks: view.tasks.map(task => ({
        id: task.id,
        title: task.title,
        description: task.description,
        status: task.status,
        dependsOn: [...task.dependsOn],
        ...task.assignee === undefined ? {} : { assignee: task.assignee },
        ...task.blockedReason === undefined ? {} : { blockedReason: task.blockedReason },
        reports: task.reports.map(report => ({ ...report })),
      })),
    },
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    activation: view.activation,
    compactionCount: view.compactionCount,
  }
}

/** Reusable canonical output declaration for the board-returning controls. */
const BOARD_OUTPUT = {
  schema: {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          board: { type: 'null', required: true },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          board: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              id: { type: 'string', required: true },
              revision: { type: 'integer', required: true },
              objective: { type: 'string', required: true },
              planOutline: { type: 'string', required: true },
              mode: { type: 'string', required: true, enum: ['serial', 'parallel'] },
              maxParallelWorkers: { type: 'integer', required: true },
              phase: { type: 'string', required: true, enum: ['active', 'paused', 'blocked', 'complete'] },
              blockedReason: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  code: { type: 'string', required: true },
                  message: { type: 'string', required: true },
                },
              },
              conductorSessionId: { type: 'string', required: true },
              handoverCount: { type: 'integer', required: true },
              tasks: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    title: { type: 'string', required: true },
                    description: { type: 'string', required: true },
                    status: { type: 'string', required: true, enum: ['todo', 'in-progress', 'done', 'blocked'] },
                    dependsOn: { type: 'array', required: true, items: { type: 'string' } },
                    assignee: { type: 'string' },
                    blockedReason: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        code: { type: 'string', required: true },
                        message: { type: 'string', required: true },
                      },
                    },
                    reports: {
                      type: 'array',
                      required: true,
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          status: { type: 'string', required: true, enum: ['progress', 'done', 'blocked'] },
                          message: { type: 'string', required: true },
                          at: { type: 'integer', required: true },
                          workerSessionId: { type: 'string', required: true },
                          workerCompactions: { type: 'integer', required: true },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          createdAt: { type: 'integer', required: true },
          updatedAt: { type: 'integer', required: true },
          activation: { type: 'string', required: true, enum: ['armed', 'disarmed'] },
          compactionCount: { type: 'integer', required: true },
        },
      },
    ],
  } as const,
  render: (_args: unknown, value: ConductorToolValue) => [{
    type: 'text' as const,
    text: JSON.stringify(value),
  }],
}

/** Render policy guidance with its deployment-selected thresholds. */
function guidance(workerHandoverAfter: number): string {
  return 'You are the conductor of an agent team. The user described an objective; analyze it, decompose '
    + 'it into subtasks with dependencies (task_create depends_on), write the implementation plan outline, '
    + 'and track progress until the board completes. Flow: conductor_init with the objective and plan '
    + 'outline, omitting mode so the user\'s saved scheduling preference applies unless they explicitly '
    + 'requested an override; task_create the decomposition; scheduling is automatic — ready tasks spawn worker '
    + 'windows in the board mode. Every worker report wakes you: read task_board, process the report, and '
    + 're-plan (task_create, task_update, conductor_update edit) when needed. Once workers are in progress, '
    + 'end your turn instead of polling or waiting in a tool loop; their task_report calls will wake you. '
    + 'Workers never communicate directly: when one worker\'s report affects another, retain that context and '
    + 'relay the actionable information yourself with conductor_message. Escalate blockers that need '
    + 'the user\'s decision with ask_user_question, then unblock and resume. When task_board shows your '
    + 'session compactionCount reaching the driver threshold, the round driver hands the role to a fresh '
    + 'window automatically; you may also call conductor_handover earlier. When a worker report shows '
    + `worker compactions >= ${workerHandoverAfter}, reassign that task (task_update action reassign) so a `
    + 'fresh window continues it. When the user asks to stop, call conductor_update action pause. You are '
    + 'the single channel to the user: report progress, completions, and blockers to them yourself.'
}

/** Validate config even when apply is called directly outside Loader normalization. */
function resolveConfig(config: Config): ResolvedConfig {
  const workerHandover = config.workerHandoverAfterCompactions ?? 4
  if (!Number.isSafeInteger(workerHandover) || workerHandover < 1) {
    throw new TypeError('workerHandoverAfterCompactions must be a positive safe integer')
  }
  return { workerHandoverAfterCompactions: workerHandover }
}

/** Whether optional text is meaningful rather than a strict-schema empty filler. */
function hasText(value: string | undefined): value is string {
  return value !== undefined && value !== ''
}

/** Brand a task id from model arguments. */
function taskRef(taskId: string): TaskIdType {
  if (taskId.length === 0 || taskId !== taskId.trim()) {
    throw new HarnessError('task_id must be a non-empty task id from task_board', 'CONDUCTOR_TOOL_INVALID_UPDATE')
  }
  return TaskId(taskId)
}

/** Generic, args-only pending presentation shared by the conductor tools. */
function present(title: string, kind: 'read' | 'other', rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, kind, ...rawInput === undefined ? {} : { rawInput } }
}

/** Register the conductor tools and their shared policy section. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  ctx.systemPrompt.section({
    name: 'tool:conductor',
    order: CONDUCTOR_SECTION_ORDER,
    // Worker windows inherit this preset's sections but have the conductor
    // tools restricted away; the guidance renders only where the tools are
    // visible, exactly like the delegation tools' own section.
    text: (context) => {
      /* v8 ignore start -- the restricted worker view is exercised by the service's workerToolFilter flow */
      if (ctx.tools.get('conductor_init', context.scope) === undefined) return ''
      /* v8 ignore stop */
      return guidance(resolved.workerHandoverAfterCompactions)
    },
  })

  ctx.tools.register(defineTool({
    name: 'conductor_init',
    description: INIT_DESCRIPTION,
    parameters: {
      objective: {
        type: 'string',
        required: true,
        description: 'The concrete user-described task objective.',
      },
      mode: {
        type: 'string',
        enum: ['serial', 'parallel'],
        description: 'serial runs one worker at a time; parallel runs ready workers concurrently. Omit to use the user\'s saved preference (parallel until changed).',
      },
      plan_outline: {
        type: 'string',
        description: 'The implementation plan outline: the module/step breakdown and its order.',
      },
      max_parallel_workers: {
        type: 'number',
        description: 'Parallel-mode cap on concurrently in-progress tasks. Defaults to the deployment value.',
      },
    },
    output: BOARD_OUTPUT,
    execute(args, exec) {
      const execution = conductorToolExecution(ctx, exec)
      const view = ctx.conductor.init(execution.agent, {
        objective: args.objective,
        ...hasText(args.mode) ? { mode: args.mode } : {},
        ...hasText(args.plan_outline) ? { planOutline: args.plan_outline } : {},
        ...args.max_parallel_workers !== undefined && args.max_parallel_workers !== 0
          ? { maxParallelWorkers: args.max_parallel_workers }
          : {},
      })
      return Promise.resolve(conductorValue(view))
    },
    presentCall: args => present('Create conductor board', 'other', args.objective),
  }))

  ctx.tools.register(defineTool({
    name: 'task_board',
    description: TASK_BOARD_DESCRIPTION,
    parameters: {},
    output: BOARD_OUTPUT,
    execute(_args, exec) {
      const execution = conductorToolExecution(ctx, exec)
      return Promise.resolve(conductorValue(ctx.conductor.get(execution.agent)))
    },
    presentCall: () => present('Read task board', 'read'),
  }))

  ctx.tools.register(defineTool({
    name: 'task_create',
    description: TASK_CREATE_DESCRIPTION,
    parameters: {
      tasks: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', required: true, description: 'Short imperative task title.' },
            description: {
              type: 'string',
              required: true,
              description: 'Self-contained work description a worker can execute without further context.',
            },
            depends_on: {
              type: 'array',
              items: { type: 'string' },
              description: 'Existing task ids that must reach done before this task may start.',
            },
          },
        },
      },
    },
    output: BOARD_OUTPUT,
    execute(args, exec) {
      const execution = conductorToolExecution(ctx, exec)
      let ref: ConductorRef | undefined
      for (const entry of args.tasks) {
        const view = ref === undefined ? ctx.conductor.get(execution.agent) : undefined
        if (ref === undefined) {
          if (view === undefined) {
            throw new ConductorError('no current board; call conductor_init first', 'CONDUCTOR_NOT_FOUND')
          }
          ref = { id: view.id, revision: view.revision }
        }
        const dependsOn = entry.depends_on === undefined ? [] : entry.depends_on.map(taskRef)
        const updated = ctx.conductor.createTask(execution.agent, ref, {
          title: entry.title,
          description: entry.description,
          ...dependsOn.length > 0 ? { dependsOn } : {},
        })
        ref = { id: updated.id, revision: updated.revision }
      }
      const view = ref === undefined ? undefined : ctx.conductor.get(execution.agent)
      return Promise.resolve(conductorValue(view))
    },
    presentCall: args => present('Create tasks', 'other', args.tasks.map(task => task.title)),
  }))

  ctx.tools.register(defineTool({
    name: 'task_update',
    description: TASK_UPDATE_DESCRIPTION,
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task id from task_board.' },
      action: {
        type: 'string',
        required: true,
        enum: ['start', 'done', 'blocked', 'unblock', 'reassign'],
        description: 'start | done | blocked | unblock | reassign',
      },
      reason: {
        type: 'string',
        description: 'Blocking explanation; required only with action blocked.',
      },
    },
    output: BOARD_OUTPUT,
    execute(args, exec) {
      const execution = conductorToolExecution(ctx, exec)
      const view = ctx.conductor.get(execution.agent)
      if (view === undefined) {
        throw new ConductorError('no current board; call conductor_init first', 'CONDUCTOR_NOT_FOUND')
      }
      const ref = { id: view.id, revision: view.revision }
      const taskId = taskRef(args.task_id)
      const updated = args.action === 'reassign'
        ? ctx.conductor.reassignTask(execution.agent, ref, taskId)
        : ctx.conductor.setTaskStatus(execution.agent, ref, taskId, statusFor(args.action),
          args.action === 'blocked' ? { code: 'model-reported', message: args.reason } : undefined)
      return Promise.resolve(conductorValue(updated))
    },
    presentCall: args => present(`${args.action.charAt(0).toUpperCase() + args.action.slice(1)} task`, 'other', args.task_id),
  }))

  ctx.tools.register(defineTool({
    name: 'conductor_update',
    description: CONDUCTOR_UPDATE_DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['edit', 'set_mode', 'pause', 'resume', 'complete', 'block'],
        description: 'edit | set_mode | pause | resume | complete | block',
      },
      objective: { type: 'string', description: 'Replacement objective; valid only with action edit.' },
      plan_outline: { type: 'string', description: 'Replacement plan outline; valid only with action edit.' },
      mode: { type: 'string', enum: ['serial', 'parallel'], description: 'Replacement mode; valid only with action set_mode.' },
      max_parallel_workers: {
        type: 'number',
        description: 'Replacement parallel cap; valid only with action set_mode.',
      },
      reason: { type: 'string', description: 'Blocking explanation; required only with action block.' },
    },
    output: BOARD_OUTPUT,
    execute(args, exec) {
      const execution = conductorToolExecution(ctx, exec)
      const view = ctx.conductor.get(execution.agent)
      if (view === undefined) {
        throw new ConductorError('no current board; call conductor_init first', 'CONDUCTOR_NOT_FOUND')
      }
      const ref = { id: view.id, revision: view.revision }
      const forbiddenExtra = hasText(args.objective) || hasText(args.plan_outline)
        || hasText(args.mode) || args.max_parallel_workers !== undefined
      if (args.action === 'edit') {
        if (hasText(args.reason)) {
          throw new HarnessError('reason is valid only with action block', 'CONDUCTOR_TOOL_INVALID_UPDATE')
        }
        if (!hasText(args.objective) && !hasText(args.plan_outline)) {
          throw new HarnessError('edit requires objective and/or plan_outline', 'CONDUCTOR_TOOL_INVALID_UPDATE')
        }
        const updated = ctx.conductor.edit(execution.agent, ref, {
          ...hasText(args.objective) ? { objective: args.objective } : {},
          ...hasText(args.plan_outline) ? { planOutline: args.plan_outline } : {},
        })
        return Promise.resolve(conductorValue(updated))
      }
      if (args.action === 'set_mode') {
        if (hasText(args.reason)) {
          throw new HarnessError('reason is valid only with action block', 'CONDUCTOR_TOOL_INVALID_UPDATE')
        }
        if (args.mode === undefined && args.max_parallel_workers === undefined) {
          throw new HarnessError('set_mode requires mode and/or max_parallel_workers', 'CONDUCTOR_TOOL_INVALID_UPDATE')
        }
        const updated = ctx.conductor.setMode(execution.agent, ref, args.mode ?? view.mode,
          args.max_parallel_workers)
        return Promise.resolve(conductorValue(updated))
      }
      if (args.action === 'block') {
        if (forbiddenExtra) {
          throw new HarnessError(
            'objective, plan_outline, mode, and max_parallel_workers are valid only with their actions',
            'CONDUCTOR_TOOL_INVALID_UPDATE',
          )
        }
        if (!hasText(args.reason)) {
          throw new HarnessError('block requires a reason', 'CONDUCTOR_TOOL_INVALID_UPDATE')
        }
        const updated = ctx.conductor.block(execution.agent, ref, {
          code: 'model-reported',
          message: args.reason,
        })
        return Promise.resolve(conductorValue(updated))
      }
      if (forbiddenExtra || hasText(args.reason)) {
        throw new HarnessError(
          'objective, plan_outline, mode, max_parallel_workers, and reason are valid only with their actions',
          'CONDUCTOR_TOOL_INVALID_UPDATE',
        )
      }
      const updated = args.action === 'pause'
        ? ctx.conductor.pause(execution.agent, ref)
        : args.action === 'resume'
          ? ctx.conductor.resume(execution.agent, ref)
          : ctx.conductor.complete(execution.agent, ref)
      return Promise.resolve(conductorValue(updated))
    },
    presentCall: args => present(
      `${args.action === 'set_mode' ? 'Set mode' : args.action.charAt(0).toUpperCase() + args.action.slice(1)} board`,
      'other',
      args.action === 'block' ? args.reason : args.action === 'edit' ? (args.plan_outline ?? args.objective) : args.action,
    ),
  }))

  ctx.tools.register(defineTool({
    name: 'task_schedule',
    description: TASK_SCHEDULE_DESCRIPTION,
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          spawned: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                taskId: { type: 'string', required: true },
                workerId: { type: 'string', required: true },
                messageId: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value: { spawned: Array<{ taskId: string; workerId: string }> }) => [{
        type: 'text',
        text: value.spawned.length === 0
          ? 'no ready tasks to spawn'
          : `spawned workers: ${value.spawned.map(entry => `${entry.taskId} -> ${entry.workerId}`).join(', ')}`,
      }],
    },
    async execute(_args, exec) {
      const execution = conductorToolExecution(ctx, exec)
      const spawned = await ctx.conductor.spawnWorkers(execution.agent)
      return Promise.resolve({ spawned })
    },
    presentCall: () => present('Schedule ready tasks', 'other'),
  }))

  ctx.tools.register(defineTool({
    name: 'conductor_message',
    description: CONDUCTOR_MESSAGE_DESCRIPTION,
    parameters: {
      worker_id: {
        type: 'string',
        required: true,
        description: 'The worker session id (a task assignee from task_board).',
      },
      message: { type: 'string', required: true, description: 'The message to deliver as the worker\'s next turn.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          messageId: { type: 'string', required: true },
        },
      },
      render: (args, _value: { messageId: string }) => [{
        type: 'text',
        text: `message queued as the next turn for worker ${args.worker_id}`,
      }],
    },
    async execute(args, exec) {
      const execution = conductorToolExecution(ctx, exec)
      const delivered = await ctx.conductor.deliver(execution.agent, SessionId(args.worker_id), args.message)
      return Promise.resolve({ messageId: delivered.messageId })
    },
    presentCall: args => present('Message worker', 'other', args.worker_id),
  }))

  ctx.tools.register(defineTool({
    name: 'conductor_handover',
    description: CONDUCTOR_HANDOVER_DESCRIPTION,
    parameters: {
      reason: {
        type: 'string',
        required: true,
        description: 'Why this window is handing over (e.g. "compacted N times").',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          childId: { type: 'string', required: true },
          messageId: { type: 'string', required: true },
        },
      },
      render: (_args, value: { childId: string }) => [{
        type: 'text',
        text: `conductor role handed to new window ${value.childId}; announce it to the user`,
      }],
    },
    async execute(args, exec) {
      const execution = conductorToolExecution(ctx, exec)
      const handed = await ctx.conductor.handover(execution.agent, args.reason)
      return Promise.resolve({ childId: handed.childId, messageId: handed.messageId })
    },
    presentCall: args => present('Hand over conductor role', 'other', args.reason),
  }))
}

/** Map a task action to the service status verb. */
function statusFor(action: string): 'in-progress' | 'done' | 'blocked' | 'todo' {
  switch (action) {
    case 'start':
      return 'in-progress'
    case 'done':
      return 'done'
    case 'blocked':
      return 'blocked'
    case 'unblock':
      return 'todo'
    /* v8 ignore next 3 -- the schema enum admits only the four actions above */
    default:
      throw new HarnessError(`unknown task action "${action}"`, 'CONDUCTOR_TOOL_INVALID_UPDATE')
  }
}
