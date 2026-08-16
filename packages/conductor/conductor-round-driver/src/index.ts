/**
 * Conductor round driver over public agent, session, and conductor services:
 * at conductor quiescence it hands over after too many compactions, spawns
 * workers for ready tasks per the board mode, and completes or blocks the
 * board when nothing can proceed — then wakes the conductor window to report.
 * @module @deepseek-ai/dsh-conductor-round-driver
 */

import { FiberState } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { allTasksDone, renderBlockedNotice, renderCompleteNotice } from '@deepseek-ai/dsh-conductor'
import type { ConductorView } from '@deepseek-ai/dsh-conductor'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

export const name = 'conductor-round-driver'
export const inject = ['agents', 'conductor', 'sessions']

/** Driver policy for automatic conductor handover. */
export interface Config {
  /** Compaction count at which the driver hands the conductor role to a fresh window. */
  handoverAfterCompactions?: number
}

/** Schemastery config for the driver policy. */
export const Config: z<Config> = z.object({
  handoverAfterCompactions: z.number().step(1).min(1).default(4),
})

/** Resolved driver policy. */
interface ResolvedConfig {
  readonly handoverAfterCompactions: number
}

/** Serialized process-local scheduling state for one exact Agent lifecycle. */
interface DriverState {
  readonly agent: Agent
  competingQueued: boolean
  needsCheckpoint: boolean
  requested: boolean
  run: Promise<void> | undefined
  stopping: boolean
}

/** Human-readable unexpected values for logs. */
function renderThrown(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** Validate config even when apply is called directly outside Loader normalization. */
function resolveConfig(config: Config): ResolvedConfig {
  const threshold = config.handoverAfterCompactions ?? 4
  if (!Number.isSafeInteger(threshold) || threshold < 1) {
    throw new TypeError('handoverAfterCompactions must be a positive safe integer')
  }
  return { handoverAfterCompactions: threshold }
}

/** Install automatic conductor advancement and its race fences. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const states = new Map<Agent, DriverState>()

  /** Create state for an exact currently live agent. */
  function stateFor(agent: Agent): DriverState {
    const existing = states.get(agent)
    if (existing !== undefined) return existing
    const state: DriverState = {
      agent,
      competingQueued: false,
      needsCheckpoint: false,
      requested: false,
      run: undefined,
      stopping: false,
    }
    states.set(agent, state)
    return state
  }

  /** Read the board only when the exact Agent remains live and is the conductor. */
  function currentBoard(state: DriverState): ConductorView | undefined {
    /* v8 ignore next 2 -- a drive racing agent disposal sees a non-live registry instance; the goal driver keeps the same fence */
    if (ctx.agents.get(state.agent.id) !== state.agent) return undefined
    const view = ctx.conductor.get(state.agent)
    if (view === undefined || view.conductorSessionId !== state.agent.session.id) return undefined
    return view
  }

  /** Whether this exact lifecycle is quiescent with no competing prompt. */
  function readyToDrive(state: DriverState): boolean {
    return ctx.fiber.state === FiberState.ACTIVE
      && !state.stopping
      && ctx.agents.get(state.agent.id) === state.agent
      && state.agent.status === 'idle'
      && !state.competingQueued
  }

  /** Recheck every condition that an awaited checkpoint may have changed. */
  function readyAfterCheckpoint(state: DriverState): boolean {
    return readyToDrive(state) && !state.needsCheckpoint
  }

  /** Deliver one driver notice as the conductor window's next turn. */
  function notice(agent: Agent, text: string, summary: string): void {
    agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'conductor-driver', form: 'notice', summary },
    }))
  }

  /** One advancement pass at conductor quiescence. */
  async function drive(state: DriverState): Promise<void> {
    const { agent } = state
    if (!readyToDrive(state)) return

    if (state.needsCheckpoint) {
      state.needsCheckpoint = false
      try {
        await ctx.sessions.flush(agent.session)
      } catch (error: unknown) {
        ctx.logger.warn(`conductor-round-driver: durability checkpoint failed for agent "${agent.id}": ${renderThrown(error)}`)
        return
      }
      if (!readyAfterCheckpoint(state)) return
    }

    const board = currentBoard(state)
    if (board === undefined || board.phase !== 'active' || board.activation !== 'armed') return

    // A conductor window that has been compacted too often hands the role to
    // a fresh window before scheduling more work.
    if (board.compactionCount >= resolved.handoverAfterCompactions) {
      try {
        const handed = await ctx.conductor.handover(agent, `automatic handover after ${board.compactionCount} compactions`)
        notice(
          agent,
          `This window has been compacted ${board.compactionCount} times. The conductor role was handed to `
            + `window ${handed.childId}. Announce the handover to the user; this window no longer schedules tasks.`,
          `handed over to ${handed.childId}`,
        )
      } catch (error: unknown) {
        ctx.logger.warn(`conductor-round-driver: automatic handover failed for agent "${agent.id}": ${renderThrown(error)}`)
      }
      return
    }

    // Spawn worker windows for the ready tasks per the board's mode. A spawn
    // failure blocks the board so the pass cannot retry forever.
    try {
      const spawned = await ctx.conductor.spawnWorkers(agent)
      if (spawned.length > 0) {
        state.needsCheckpoint = true
        return
      }
    } catch (error: unknown) {
      const latest = currentBoard(state)
      /* v8 ignore next -- the drive only spawns from an active armed board; a mid-spawn pause/clear race leaves the board as-is */
      if (latest !== undefined && latest.phase === 'active') {
        try {
          ctx.conductor.block(agent, { id: latest.id, revision: latest.revision }, {
            code: 'spawn-failed',
            message: `could not spawn workers: ${renderThrown(error)}`,
          })
          const blocked = currentBoard(state)
          if (blocked !== undefined) {
            notice(agent, renderBlockedNotice(blocked), `blocked: ${renderThrown(error)}`)
          }
        } catch (blockError: unknown) {
          ctx.logger.warn(`conductor-round-driver: could not block the board after a spawn failure for agent "${agent.id}": ${renderThrown(blockError)}`)
        }
      }
      return
    }

    // Nothing was spawned: either work is in flight, everything is done, or
    // something is blocked.
    const latest = currentBoard(state)
    /* v8 ignore next 2 -- a board vanishing mid-drive (clear/teardown race) leaves nothing to decide */
    if (latest === undefined) return
    if (latest.tasks.some(task => task.status === 'in-progress')) return
    if (allTasksDone(latest)) {
      try {
        ctx.conductor.complete(agent, { id: latest.id, revision: latest.revision })
        const completed = currentBoard(state)
        if (completed !== undefined) {
          notice(agent, renderCompleteNotice(completed), `board complete (${completed.tasks.length} tasks)`)
        }
      } catch (error: unknown) {
        ctx.logger.warn(`conductor-round-driver: could not complete the board for agent "${agent.id}": ${renderThrown(error)}`)
      }
      return
    }
    /* v8 ignore next -- the dep-blocking pass folds every dep-blocked task into blocked, so a no-spawn board hits an earlier branch */
    if (latest.tasks.some(task => task.status === 'blocked')) {
      try {
        ctx.conductor.block(agent, { id: latest.id, revision: latest.revision }, {
          code: 'blocked-tasks',
          message: 'no task can proceed: blocked tasks are waiting on a decision',
        })
        const blocked = currentBoard(state)
        if (blocked !== undefined) {
          notice(agent, renderBlockedNotice(blocked), 'board blocked: no task can proceed')
        }
      } catch (error: unknown) {
        ctx.logger.warn(`conductor-round-driver: could not block the board for agent "${agent.id}": ${renderThrown(error)}`)
      }
      return
    }
    // A board with only todo tasks whose dependencies are not done yet and
    // nothing blocked or in progress is a paused planning window: wait.
  }

  /** Coalesce triggers onto one agent-local serialized driver. */
  function requestDrive(state: DriverState): void {
    /* v8 ignore next -- teardown may race a final trigger after synchronously closing the step fence */
    if (state.stopping) return
    state.requested = true
    if (state.run !== undefined) return
    let run: Promise<void>
    try {
      run = ctx.agents.withoutInitiator(async () => {
        while (state.requested && !state.stopping) {
          state.requested = false
          try {
            await drive(state)
          } catch (error: unknown) {
            ctx.logger.warn(`conductor-round-driver: driver failed for agent "${state.agent.id}": ${renderThrown(error)}`)
          }
        }
      })
    } catch (error: unknown) {
      ctx.logger.warn(`conductor-round-driver: could not start driver for agent "${state.agent.id}": ${renderThrown(error)}`)
      return
    }
    state.run = run
    const retire = (): void => {
      state.run = undefined
      if (state.requested && !state.stopping) requestDrive(state)
    }
    void run.then(retire, (error: unknown) => {
      ctx.logger.warn(`conductor-round-driver: driver task rejected for agent "${state.agent.id}": ${renderThrown(error)}`)
      retire()
    })
  }

  // One composite effect keeps the step fence installed until this
  // plugin's own scheduling tasks settle.
  ctx.effect(function* () {
    ctx.on('agent/error', ({ agent }) => {
      stateFor(agent)
      try {
        ctx.conductor.disarm(agent)
      } catch (error: unknown) {
        ctx.logger.warn(`conductor-round-driver: could not disarm agent "${agent.id}": ${renderThrown(error)}`)
      }
    })

    ctx.on('agent/created', ({ agent }) => { stateFor(agent) })
    ctx.on('agent/disposed', ({ agent }) => { states.delete(agent) })
    ctx.on('agent/session-start', ({ agent }) => {
      const state = stateFor(agent)
      state.competingQueued = false
      state.needsCheckpoint = false
    })
    ctx.on('agent/status', ({ agent, status }) => {
      const state = stateFor(agent)
      if (status === 'idle') {
        state.competingQueued = false
        requestDrive(state)
      }
    })
    ctx.on('conductor/changed', ({ agent }) => {
      const state = stateFor(agent)
      state.needsCheckpoint = true
      requestDrive(state)
    })
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (!agent.inbox.nextTurn.some(candidate => candidate.id === message.id)) return
      const state = stateFor(agent)
      state.competingQueued = true
    })

    // Loading a lifecycle driver over existing agents never inherits hidden
    // automatic authority from an earlier producer instance.
    for (const agent of ctx.agents.list()) {
      stateFor(agent)
      try {
        ctx.conductor.disarm(agent)
      } catch (error: unknown) {
        ctx.logger.warn(`conductor-round-driver: could not disarm agent "${agent.id}": ${renderThrown(error)}`)
      }
    }

    // Yielded after listener registration, so this close runs first and the
    // composite effect removes listeners only after its promise settles.
    yield async () => {
      const waits: Promise<void>[] = []
      for (const state of states.values()) {
        state.stopping = true
        try {
          ctx.conductor.disarm(state.agent)
        } catch (error: unknown) {
          ctx.logger.warn(`conductor-round-driver: could not disarm agent "${state.agent.id}": ${renderThrown(error)}`)
        }
        if (state.run !== undefined) waits.push(state.run)
      }
      await Promise.allSettled(waits)
      states.clear()
    }
  }, 'conductor-round-driver lifecycle')
}
