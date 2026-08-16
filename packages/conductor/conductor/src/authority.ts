/** Execution-time authority checks shared by the model-facing conductor tools. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

type TurnStartEvent = Extract<SessionEvent, { type: 'turn/start' }>

/** Current open turn plus the events accepted after its start boundary. */
export interface ConductorToolExecution {
  readonly agent: Agent
  readonly start: TurnStartEvent
  readonly events: readonly SessionEvent[]
}

/** Throw one structured tool-policy failure. */
function reject(message: string, code = 'CONDUCTOR_TOOL_AUTHORITY_REQUIRED'): never {
  throw new HarnessError(message, code)
}

/** Locate the open turn enclosing a model tool call. */
function openTurn(agent: Agent): { start: TurnStartEvent; events: readonly SessionEvent[] } {
  const events = agent.session.events
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const boundary = events[index]
    if (boundary?.type === 'turn/end') {
      reject('conductor tools require an open model turn', 'CONDUCTOR_TOOL_DRIVER_REQUIRED')
    }
    if (boundary?.type === 'turn/start') {
      return { start: boundary, events: events.slice(index + 1) }
    }
  }
  return reject('conductor tools require an open model turn', 'CONDUCTOR_TOOL_DRIVER_REQUIRED')
}

/**
 * Resolve and authenticate the calling agent and its driver boundary.
 * @param ctx - Context carrying the live agent registry.
 * @param exec - Tool execution metadata supplied by the registry.
 * @returns the authenticated agent and its current turn window.
 */
export function conductorToolExecution(ctx: Context, exec: ToolRunContext): ConductorToolExecution {
  const agent = exec.agent
  if (agent === undefined) {
    return reject('conductor tools require a calling agent', 'CONDUCTOR_TOOL_AGENT_REQUIRED')
  }
  if (ctx.agents.get(agent.id) !== agent || agent.status !== 'running'
    || ctx.agents.currentInitiator() !== agent) {
    return reject(
      'conductor tools require the exact live calling agent inside its active driver',
      'CONDUCTOR_TOOL_DRIVER_REQUIRED',
    )
  }
  return { agent, ...openTurn(agent) }
}
