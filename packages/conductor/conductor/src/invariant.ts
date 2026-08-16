/** Package-owned durable conductor-stream invariants. @module @deepseek-ai/dsh-conductor/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { applyConductorEvent, emptyConductorFoldState } from './fold.ts'
import type { ConductorFoldState } from './fold.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-conductor'

/** Cordis companion plugin name. */
export const name = 'conductor-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Copy the independent fold before validating one candidate event. */
function cloneState(state: ConductorFoldState): ConductorFoldState {
  return {
    board: state.board,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    lastRef: state.lastRef,
    seenBoardIds: new Set(state.seenBoardIds),
  }
}

/** Apply one event through the strict conductor decoder and attribute failures. */
function applyChecked(state: ConductorFoldState, event: SessionEvent, fail: InvariantFailure): void {
  try {
    applyConductorEvent(state, event)
  } catch (error) {
    /* v8 ignore next -- the strict conductor decoder throws Error instances */
    const message = error instanceof Error ? error.message : String(error)
    fail(`session event ${event.seq} violates the durable conductor stream: ${message}`)
  }
}

/** Install an independent incremental fold over every attached session. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const states = new WeakMap<Session, ConductorFoldState>()
  const staged = new WeakMap<SessionEvent, { session: Session; state: ConductorFoldState }>()

  const seed = (session: Session): ConductorFoldState => {
    const state = emptyConductorFoldState()
    /* v8 ignore next 2 -- the seed loop runs only when the companion mounts over pre-existing sessions */
    for (const event of session.events) applyChecked(state, event, fail)
    states.set(session, state)
    return state
  }
  /* v8 ignore next 2 -- same pre-existing-session path as the seed loop above */
  const stateFor = (session: Session): ConductorFoldState => states.get(session) ?? seed(session)

  /* v8 ignore next 2 -- the companion's seed path runs only when it mounts over pre-existing sessions */
  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    const state = cloneState(stateFor(session))
    applyChecked(state, event, fail)
    staged.set(event, { session, state })
  }, { global: true })
  ctx.on('session/event', (session, event) => {
    const candidate = staged.get(event)
    /* v8 ignore next 2 -- internal/dispatch stages the exact callback arguments */
    if (candidate === undefined || candidate.session !== session) {
      return fail('session/event reached publication without matching conductor-fold validation')
    }
    staged.delete(event)
    states.set(session, candidate.state)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register the conductor-stream invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
