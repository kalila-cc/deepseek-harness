/**
 * The worker-scoped `task_report` tool: structured completion, blocker, and
 * progress reporting from an assigned worker window into the current
 * conductor's board, delivered to the conductor window.
 * @module @deepseek-ai/dsh-tool-task-report
 */

import type { Context } from '@deepseek-ai/cordis'
import { ConductorError, TaskId, conductorToolExecution } from '@deepseek-ai/dsh-conductor'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'

export const name = 'tool-task-report'
export const inject = ['agents', 'conductor', 'tools', 'systemPrompt']

const REPORT_DESCRIPTION =
  'Report about your assigned task to the conductor. Use status "done" once with a self-contained '
  + 'summary of what you changed and where when you finish; "blocked" with the exact condition when a '
  + 'blocker needs the conductor\'s or the user\'s decision; "progress" for significant interim findings. '
  + 'Report cross-task context here instead of contacting sibling workers; the conductor relays it. Reporting '
  + 'does not end your turn and does not grant you anything: after your final report, end your '
  + 'turn and wait for follow-up messages. A failed call may still have arrived, so do not blindly repeat it.'

/** Generic, args-only pending presentation shared by the report tool. */
function present(title: string, kind: 'read' | 'other', rawInput?: unknown): GenericCallView {
  /* v8 ignore next -- the report tool always supplies its task id as the raw input */
  return { card: 'generic', title, kind, ...rawInput === undefined ? {} : { rawInput } }
}

/**
 * Register the `task_report` tool.
 * @param ctx - context carrying the tool registry and conductor service.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'task_report',
    description: REPORT_DESCRIPTION,
    parameters: {
      task_id: {
        type: 'string',
        required: true,
        description: 'The task id from your worker briefing.',
      },
      status: {
        type: 'string',
        required: true,
        enum: ['progress', 'done', 'blocked'],
        description: 'progress | done | blocked',
      },
      message: {
        type: 'string',
        required: true,
        description: 'Self-contained summary, blocker, or progress note for the conductor.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          messageId: { type: 'string', required: true },
        },
      },
      render: (_args, value: { messageId: string }) => [{
        type: 'text',
        text: `report accepted by the conductor as message ${value.messageId}`,
      }],
    },
    execute(args, exec) {
      const execution = conductorToolExecution(ctx, exec)
      if (args.task_id.length === 0 || args.task_id !== args.task_id.trim()) {
        throw new HarnessError('task_id must be a non-empty task id from your briefing', 'CONDUCTOR_TOOL_INVALID_UPDATE')
      }
      const message = args.message.trim()
      if (message.length === 0) {
        throw new ConductorError('a task report requires a non-empty message', 'CONDUCTOR_INVALID_REPORT')
      }
      const delivered = ctx.conductor.report(execution.agent, {
        taskId: TaskId(args.task_id),
        status: args.status,
        message,
      })
      return Promise.resolve({ messageId: delivered.messageId })
    },
    presentCall: args => present(`Report task ${args.status}`, 'other', args.task_id),
  }))
}
