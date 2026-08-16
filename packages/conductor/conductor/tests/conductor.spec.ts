import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import ConductorService, { CONDUCTOR_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-conductor'
import { ConductorId, TaskId } from '@deepseek-ai/dsh-conductor'
import type { ConductorRef, ConductorSnapshot } from '@deepseek-ai/dsh-conductor'
import type { ContinuableStart } from '@deepseek-ai/dsh-subagent'

interface StubAgent {
  agent: Agent
  session: Session
  followups: UserMessage[]
}

/** Build a registry-compatible agent around one concrete session. */
function stubAgentForSession(session: Session): StubAgent {
  const id = session.id
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  const followups: UserMessage[] = []
  const agent: Agent = {
    id,
    options: {},
    session,
    inbox,
    ctx: new Context(),
    status: 'idle',
    send: () => {},
    followup(message) { followups.push(message) },
    steer: () => {},
    inject() {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  return { agent, session, followups }
}

/** Fake subagents service recording starts and followups. */
function fakeSubagents(ctx: Context) {
  const startContinuable = vi.fn(async (spec: { label: string; request: { parent: Agent } }): Promise<ContinuableStart> => {
    const childId = `child-${spec.label}-${startContinuable.mock.calls.length}`
    ctx.sessions.create(SessionId(childId), {
      meta: {
        parentSession: spec.request.parent.session.id,
        origin: 'subagent',
        delegationDepth: 1,
      },
    })
    return { childId: SessionId(childId), messageId: `message-${childId}` as MessageId }
  })
  const followup = vi.fn(async () => 'cold-resumed-message')
  ctx.provide('subagents', { startContinuable, followup } as never)
  return { startContinuable, followup }
}

interface Harness {
  ctx: Context
  conductor: ConductorService
  agent: Agent
  session: Session
  followups: UserMessage[]
  startContinuable: ReturnType<typeof fakeSubagents>['startContinuable']
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(context => context.fiber.dispose()))
})

/** Mount the services and one top-level conductor agent in the session store. */
async function harness(config: ConstructorParameters<typeof ConductorService>[1] = {}): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const { startContinuable } = fakeSubagents(ctx)
  await ctx.plugin(ConductorService, config)
  const session = ctx.sessions.create(SessionId(`conductor-test-${Math.random()}`), {
    meta: { cwd: process.cwd() },
  })
  const stub = stubAgentForSession(session)
  ctx.agents.register(stub.agent)
  return {
    ctx,
    conductor: ctx.conductor,
    agent: stub.agent,
    session,
    followups: stub.followups,
    startContinuable,
  }
}

/** Append one compaction summary event to a session. */
function appendCompaction(session: Session): void {
  session.append('compaction/summary', {
    compactionId: CompactionId(`compaction-${session.seq}`),
    summary: [],
    shadowedRange: { start: 0, end: 0 },
    shadowedSeqs: [],
    shadowedTokenCount: 0,
    provider: 'mock',
    model: 'mock',
    rawOutput: [],
    llmStreamCall: true,
  })
}

/** A board with one todo task; returns the ref and task id. */
function boardWithTask(h: { conductor: ConductorService; agent: Agent }): { ref: ConductorRef; taskId: ConductorSnapshot['tasks'][number]['id'] } {
  const init = h.conductor.init(h.agent, { objective: 'build the feature' })
  const created = h.conductor.createTask(h.agent, { id: init.id, revision: init.revision }, {
    title: 'write module',
    description: 'write the module',
  })
  return { ref: { id: created.id, revision: created.revision }, taskId: created.tasks[0]?.id ?? TaskId('missing') }
}

/** Register one live agent over an existing stored session. */
function liveAgentFor(h: Harness, session: Session): StubAgent {
  const stub = stubAgentForSession(session)
  h.ctx.agents.register(stub.agent)
  return stub
}

/** Create a worker session whose durable parent is the conductor session. */
function workerSession(h: Harness, rawId: string): Session {
  return Session.create(SessionId(rawId), undefined, {
    version: 0,
    id: SessionId(rawId),
    createdAt: Date.now(),
    parentSession: h.session.id,
    origin: 'subagent',
    delegationDepth: 1,
  })
}

describe('ConductorService creation and replay', () => {
  it('creates an armed serial board with one durable change', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
    const { ctx, conductor, agent, session } = await harness()
    const seen: string[] = []
    ctx.on('conductor/changed', ({ change }) => { seen.push(change.operation) })

    const view = conductor.init(agent, { objective: '  build the feature  ', planOutline: '1. plan', mode: 'serial' })

    expect(view).toMatchObject({
      objective: 'build the feature',
      planOutline: '1. plan',
      mode: 'serial',
      maxParallelWorkers: 3,
      phase: 'active',
      revision: 1,
      conductorSessionId: session.id,
      handoverCount: 0,
      tasks: [],
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      activation: 'armed',
      compactionCount: 0,
    })
    expect(view.id).toMatch(/^conductor-/)
    expect(seen).toEqual(['init'])
    expect(session.events.map(event => event.type)).toEqual(['conductor/change'])
    expect(session.deriveMessages()).toEqual([])
    expect(conductor.get(agent)).toMatchObject({ id: view.id, activation: 'armed' })
    vi.useRealTimers()
  })

  it('defaults to the configured parallel cap and rejects duplicate init', async () => {
    const { conductor, agent } = await harness({ maxParallelWorkers: 5 })
    const view = conductor.init(agent, { objective: 'x', mode: 'parallel' })
    expect(view.maxParallelWorkers).toBe(5)
    expect(() => conductor.init(agent, { objective: 'y' })).toThrow(expect.objectContaining({
      code: 'CONDUCTOR_ALREADY_EXISTS',
    }))
  })

  it('rejects a blank objective on a fresh session', async () => {
    const { conductor, agent } = await harness()
    expect(() => conductor.init(agent, { objective: '   ' })).toThrow(expect.objectContaining({
      code: 'CONDUCTOR_INVALID_OBJECTIVE',
    }))
  })

  it('rejects a delegated worker session as conductor', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    fakeSubagents(ctx)
    await ctx.plugin(ConductorService)
    const workerSession = Session.create(SessionId('worker-top-level'), undefined, {
      version: 0,
      id: SessionId('worker-top-level'),
      createdAt: Date.now(),
      origin: 'subagent',
      delegationDepth: 1,
    })
    const worker = stubAgentForSession(workerSession)
    ctx.agents.register(worker.agent)
    expect(() => ctx.conductor.init(worker.agent, { objective: 'x' })).toThrow(expect.objectContaining({
      code: 'CONDUCTOR_NOT_TOP_LEVEL',
    }))
  })

  it('replaces a completed board and clears a current one', async () => {
    const { conductor, agent } = await harness()
    const first = conductor.init(agent, { objective: 'first' })
    conductor.complete(agent, { id: first.id, revision: first.revision })
    const second = conductor.init(agent, { objective: 'second' })
    expect(second.objective).toBe('second')
    const tombstone = conductor.clear(agent, { id: second.id, revision: second.revision })
    expect(tombstone).toEqual({ id: second.id, revision: second.revision + 1 })
    expect(conductor.get(agent)).toBeUndefined()
  })

  it('counts compaction summary events in the session log', async () => {
    const { conductor, session } = await harness()
    expect(conductor.compactionCount(session)).toBe(0)
    appendCompaction(session)
    appendCompaction(session)
    expect(conductor.compactionCount(session)).toBe(2)
  })
})

describe('board mutations and authority', () => {
  it('edits objective and plan outline with a CAS ref', async () => {
    const { conductor, agent } = await harness()
    const init = conductor.init(agent, { objective: 'a', planOutline: 'p' })
    const edited = conductor.edit(agent, { id: init.id, revision: init.revision }, { objective: 'b' })
    expect(edited.objective).toBe('b')
    expect(edited.planOutline).toBe('p')
    expect(edited.revision).toBe(init.revision + 1)
    expect(() => conductor.edit(agent, { id: init.id, revision: init.revision }, { objective: 'c' }))
      .toThrow(expect.objectContaining({ code: 'CONDUCTOR_STALE_REVISION' }))
    expect(() => conductor.edit(agent, { id: edited.id, revision: edited.revision }, {}))
      .toThrow(expect.objectContaining({ code: 'CONDUCTOR_INVALID_EDIT' }))
  })

  it('switches mode and parallel cap', async () => {
    const { conductor, agent } = await harness()
    const init = conductor.init(agent, { objective: 'a' })
    const switched = conductor.setMode(agent, { id: init.id, revision: init.revision }, 'parallel', 7)
    expect(switched.mode).toBe('parallel')
    expect(switched.maxParallelWorkers).toBe(7)
    expect(() => conductor.setMode(agent, { id: switched.id, revision: switched.revision }, 'parallel', 7))
      .toThrow(expect.objectContaining({ code: 'CONDUCTOR_INVALID_EDIT' }))
    const capOnly = conductor.setMode(agent, { id: switched.id, revision: switched.revision }, 'serial')
    expect(capOnly.mode).toBe('serial')
    expect(capOnly.maxParallelWorkers).toBe(7)
  })

  it('rejects resume from complete and resume of an armed board', async () => {
    const { conductor, agent } = await harness()
    const init = conductor.init(agent, { objective: 'a' })
    const ref = { id: init.id, revision: init.revision }
    expect(() => conductor.resume(agent, ref))
      .toThrow(expect.objectContaining({ code: 'CONDUCTOR_INVALID_TRANSITION' }))
    conductor.complete(agent, ref)
    expect(() => conductor.resume(agent, { id: init.id, revision: init.revision + 1 }))
      .toThrow(expect.objectContaining({ code: 'CONDUCTOR_INVALID_TRANSITION' }))
  })

  it('rejects invalid init inputs and an edit with no replacement fields', async () => {
    const { conductor, agent } = await harness()
    expect(() => conductor.init(agent, { objective: 'a', planOutline: ' spaced ' }))
      .toThrow(expect.objectContaining({ code: 'CONDUCTOR_INVALID_PLAN_OUTLINE' }))
    expect(() => conductor.init(agent, { objective: 'a', mode: 'burst' as never }))
      .toThrow(expect.objectContaining({ code: 'CONDUCTOR_INVALID_MODE' }))
    const view = conductor.init(agent, { objective: 'a' })
    const task = conductor.createTask(agent, { id: view.id, revision: view.revision }, { title: 'one', description: 'd' })
    const idOne = task.tasks[0]?.id ?? TaskId('missing')
    expect(() => conductor.editTask(agent, { id: task.id, revision: task.revision }, idOne, {}))
      .toThrow(expect.objectContaining({ code: 'CONDUCTOR_INVALID_EDIT' }))
    expect(() => conductor.setTaskStatus(agent, { id: task.id, revision: task.revision }, TaskId('ghost'), 'done'))
      .toThrow(expect.objectContaining({ code: 'CONDUCTOR_TASK_NOT_FOUND' }))
    expect(() => conductor.createTask(agent, { id: task.id, revision: task.revision }, {
      title: 'x',
      description: 'y',
      dependsOn: [TaskId('')],
    })).toThrow(expect.objectContaining({ code: 'CONDUCTOR_TASK_DEPENDENCY' }))
  })

  it('enforces board phase transitions and block reasons', async () => {
    const { conductor, agent } = await harness()
    const init = conductor.init(agent, { objective: 'a' })
    const ref = { id: init.id, revision: init.revision }
    conductor.pause(agent, ref)
    expect(() => conductor.pause(agent, { id: init.id, revision: init.revision + 1 }))
      .toThrow(expect.objectContaining({ code: 'CONDUCTOR_INVALID_TRANSITION' }))
    expect(() => conductor.block(agent, { id: init.id, revision: init.revision + 1 }, { code: 'x', message: 'y' }))
      .toThrow(expect.objectContaining({ code: 'CONDUCTOR_INVALID_TRANSITION' }))
    conductor.resume(agent, { id: init.id, revision: init.revision + 1 })
    const blocked = conductor.block(agent, { id: init.id, revision: init.revision + 2 }, { code: 'user-decision', message: ' ask ' })
    expect(blocked.phase).toBe('blocked')
    expect(blocked.blockedReason).toEqual({ code: 'user-decision', message: 'ask' })
    expect(blocked.activation).toBe('disarmed')
    const resumed = conductor.resume(agent, { id: blocked.id, revision: blocked.revision })
    expect(resumed.phase).toBe('active')
    expect(resumed.activation).toBe('armed')
    expect(resumed.blockedReason).toBeUndefined()
  })

  it('rejects board mutations without a current board', async () => {
    const { conductor, agent } = await harness()
    expect(() => conductor.edit(agent, { id: ConductorId('nope'), revision: 1 }, { objective: 'b' }))
      .toThrow(expect.objectContaining({ code: 'CONDUCTOR_NOT_FOUND' }))
  })

  it('rejects a live agent that is not the registered instance', async () => {
    const { conductor, session } = await harness()
    const other = stubAgentForSession(session)
    expect(() => conductor.init(other.agent, { objective: 'a' }))
      .toThrow(expect.objectContaining({ code: 'CONDUCTOR_AGENT_NOT_LIVE' }))
  })
})

describe('task management', () => {
  it('rejects no-op mutations before they enter the durable session log', async () => {
    const h = await harness()
    const init = h.conductor.init(h.agent, { objective: 'a' })

    const beforeBoardEdit = h.session.seq
    expect(() => h.conductor.edit(h.agent, { id: init.id, revision: init.revision }, { objective: ' a ' }))
      .toThrow(expect.objectContaining({ code: 'CONDUCTOR_INVALID_EDIT' }))
    expect(h.session.seq).toBe(beforeBoardEdit)

    const created = h.conductor.createTask(h.agent, { id: init.id, revision: init.revision }, {
      title: 'one',
      description: 'first',
    })
    const taskId = created.tasks[0]?.id ?? TaskId('missing')
    const ref = { id: created.id, revision: created.revision }
    const beforeTaskNoOps = h.session.seq
    expect(() => h.conductor.editTask(h.agent, ref, taskId, { title: 'one' }))
      .toThrow(expect.objectContaining({ code: 'CONDUCTOR_INVALID_EDIT' }))
    expect(() => h.conductor.setTaskStatus(h.agent, ref, taskId, 'todo'))
      .toThrow(expect.objectContaining({ code: 'CONDUCTOR_INVALID_TASK' }))
    expect(() => h.conductor.reassignTask(h.agent, ref, taskId))
      .toThrow(expect.objectContaining({ code: 'CONDUCTOR_INVALID_TASK' }))
    expect(h.session.seq).toBe(beforeTaskNoOps)

    const done = h.conductor.setTaskStatus(h.agent, ref, taskId, 'done')
    const beforeDoneNoOp = h.session.seq
    expect(() => h.conductor.setTaskStatus(
      h.agent,
      { id: done.id, revision: done.revision },
      taskId,
      'done',
    )).toThrow(expect.objectContaining({ code: 'CONDUCTOR_INVALID_TASK' }))
    expect(h.session.seq).toBe(beforeDoneNoOp)
    expect(h.conductor.get(h.agent)).toMatchObject({ revision: done.revision })
  })

  it('creates tasks with validated dependencies', async () => {
    const { conductor, agent } = await harness()
    const init = conductor.init(agent, { objective: 'a' })
    const ref = { id: init.id, revision: init.revision }
    const one = conductor.createTask(agent, ref, { title: 'one', description: 'first' })
    const idOne = one.tasks[0]?.id ?? TaskId('missing')
    const two = conductor.createTask(agent, { id: one.id, revision: one.revision }, {
      title: 'two',
      description: 'second',
      dependsOn: [idOne],
    })
    expect(two.tasks).toHaveLength(2)
    expect(two.tasks[1]).toMatchObject({ status: 'todo', dependsOn: [idOne] })
    expect(() => conductor.createTask(agent, { id: two.id, revision: two.revision }, {
      title: 'x',
      description: 'y',
      dependsOn: [TaskId('unknown')],
    })).toThrow(expect.objectContaining({ code: 'CONDUCTOR_TASK_DEPENDENCY' }))
    expect(() => conductor.createTask(agent, { id: two.id, revision: two.revision }, {
      title: 'x',
      description: 'y',
      dependsOn: [idOne, idOne],
    })).toThrow(expect.objectContaining({ code: 'CONDUCTOR_TASK_DEPENDENCY' }))
  })

  it('edits a task and rejects dependency cycles', async () => {
    const { conductor, agent } = await harness()
    const init = conductor.init(agent, { objective: 'a' })
    const one = conductor.createTask(agent, { id: init.id, revision: init.revision }, { title: 'one', description: 'first' })
    const idOne = one.tasks[0]?.id ?? TaskId('missing')
    const two = conductor.createTask(agent, { id: one.id, revision: one.revision }, {
      title: 'two',
      description: 'second',
      dependsOn: [idOne],
    })
    const idTwo = two.tasks[1]?.id ?? TaskId('missing')
    const edited = conductor.editTask(agent, { id: two.id, revision: two.revision }, idTwo, { title: 'two!' })
    expect(edited.tasks[1]).toMatchObject({ title: 'two!' })
    const described = conductor.editTask(agent, { id: edited.id, revision: edited.revision }, idTwo, { description: 'updated' })
    expect(described.tasks[1]).toMatchObject({ description: 'updated' })
    expect(() => conductor.editTask(agent, { id: described.id, revision: described.revision }, idOne, {
      dependsOn: [idTwo],
    })).toThrow(expect.objectContaining({ code: 'CONDUCTOR_TASK_DEPENDENCY' }))
  })

  it('transitions task status with blocked reasons and done protection', async () => {
    const { conductor, agent } = await harness()
    const { ref, taskId } = boardWithTask({ conductor, agent })
    const started = conductor.setTaskStatus(agent, ref, taskId, 'in-progress')
    expect(started.tasks[0]?.status).toBe('in-progress')
    expect(() => conductor.setTaskStatus(agent, { id: started.id, revision: started.revision }, taskId, 'blocked'))
      .toThrow(expect.objectContaining({ code: 'CONDUCTOR_INVALID_BLOCK_REASON' }))
    const blocked = conductor.setTaskStatus(agent, { id: started.id, revision: started.revision }, taskId, 'blocked', {
      code: 'model-reported',
      message: 'stuck',
    })
    expect(blocked.tasks[0]).toMatchObject({ status: 'blocked', blockedReason: { code: 'model-reported', message: 'stuck' } })
    const unblocked = conductor.setTaskStatus(agent, { id: blocked.id, revision: blocked.revision }, taskId, 'todo')
    expect(unblocked.tasks[0]).toMatchObject({ status: 'todo' })
    const done = conductor.setTaskStatus(agent, { id: unblocked.id, revision: unblocked.revision }, taskId, 'done')
    expect(done.tasks[0]?.status).toBe('done')
    expect(() => conductor.setTaskStatus(agent, { id: done.id, revision: done.revision }, taskId, 'todo'))
      .toThrow(expect.objectContaining({ code: 'CONDUCTOR_INVALID_TASK' }))
  })

  it('reassigns a task back to todo without an assignee and rejects done tasks', async () => {
    const { conductor, agent } = await harness()
    const init = conductor.init(agent, { objective: 'a' })
    const one = conductor.createTask(agent, { id: init.id, revision: init.revision }, { title: 'one', description: 'd1' })
    const idOne = one.tasks[0]?.id ?? TaskId('missing')
    const two = conductor.createTask(agent, { id: one.id, revision: one.revision }, { title: 'two', description: 'd2' })
    const idTwo = two.tasks[1]?.id ?? TaskId('missing')
    const started = conductor.setTaskStatus(agent, { id: two.id, revision: two.revision }, idOne, 'in-progress')
    const assigned = conductor.reassignTask(agent, { id: started.id, revision: started.revision }, idOne)
    expect(assigned.tasks[0]?.status).toBe('todo')
    expect('assignee' in (assigned.tasks[0] ?? {})).toBe(false)
    const done = conductor.setTaskStatus(agent, { id: assigned.id, revision: assigned.revision }, idTwo, 'done')
    expect(() => conductor.reassignTask(agent, { id: done.id, revision: done.revision }, idTwo))
      .toThrow(expect.objectContaining({ code: 'CONDUCTOR_INVALID_TASK' }))
  })
})

describe('worker reports', () => {
  it('rejects reports from a session that is not the task assignee', async () => {
    const h = await harness()
    const { ref, taskId } = boardWithTask(h)
    void ref
    const stranger = liveAgentFor(h, workerSession(h, 'stranger-worker'))
    expect(() => h.conductor.report(stranger.agent, { taskId, status: 'done', message: 'done!' }))
      .toThrow(expect.objectContaining({ code: 'CONDUCTOR_WORKER_NOT_ASSIGNED' }))
  })

  it('rejects reports after the task is done and empty messages', async () => {
    const h = await harness()
    const { ref, taskId } = boardWithTask(h)
    void ref
    await h.conductor.spawnWorkers(h.agent)
    const view = h.conductor.get(h.agent)
    const session = h.ctx.sessions.get(view?.tasks[0]?.assignee ?? SessionId('missing'))
    if (session === undefined) throw new Error('expected the worker session')
    const worker = liveAgentFor(h, session)
    expect(() => h.conductor.report(worker.agent, { taskId, status: 'done', message: '   ' }))
      .toThrow(expect.objectContaining({ code: 'CONDUCTOR_INVALID_REPORT' }))
    h.conductor.report(worker.agent, { taskId, status: 'done', message: 'finished' })
    expect(() => h.conductor.report(worker.agent, { taskId, status: 'progress', message: 'again' }))
      .toThrow(expect.objectContaining({ code: 'CONDUCTOR_INVALID_REPORT' }))
  })

  it('commits a report, updates the board, and wakes the conductor with a framed message', async () => {
    const h = await harness()
    const { ref, taskId } = boardWithTask(h)
    void ref
    await h.conductor.spawnWorkers(h.agent)
    const view = h.conductor.get(h.agent)
    const session = h.ctx.sessions.get(view?.tasks[0]?.assignee ?? SessionId('missing'))
    if (session === undefined) throw new Error('expected the worker session')
    const worker = liveAgentFor(h, session)
    const reported = h.conductor.report(worker.agent, { taskId, status: 'done', message: 'built it' })
    expect(reported.messageId).toBeTruthy()
    const after = h.conductor.get(h.agent)
    expect(after?.tasks[0]).toMatchObject({ status: 'done' })
    expect(after?.tasks[0]?.reports).toHaveLength(1)
    expect(after?.tasks[0]?.reports[0]).toMatchObject({
      status: 'done',
      message: 'built it',
      workerSessionId: session.id,
      workerCompactions: 0,
    })
    expect(h.followups).toHaveLength(1)
    const text = h.followups[0]?.content.map(block => 'text' in block ? block.text : '').join('')
    expect(text).toContain('Task report for')
    expect(text).toContain('status: done')
    expect(text).toContain('built it')
  })

  it('routes a report through the current conductor after a handover', async () => {
    const h = await harness()
    const { ref, taskId } = boardWithTask(h)
    void ref
    await h.conductor.spawnWorkers(h.agent)
    const view = h.conductor.get(h.agent)
    const session = h.ctx.sessions.get(view?.tasks[0]?.assignee ?? SessionId('missing'))
    if (session === undefined) throw new Error('expected the worker session')
    const worker = liveAgentFor(h, session)
    await h.conductor.handover(h.agent, 'quality')
    // The successor is the second session the fake created.
    const stored = h.ctx.sessions.list()
    const successor = stored.find(candidate =>
      String(candidate.id) !== String(h.session.id) && String(candidate.id) !== String(session.id))
    if (successor === undefined) throw new Error('expected the successor session')
    const successorStub = liveAgentFor(h, successor)
    const reported = h.conductor.report(worker.agent, { taskId, status: 'done', message: 'routed' })
    expect(reported.messageId).toBeTruthy()
    expect(successorStub.followups).toHaveLength(1)
    expect(successorStub.followups[0]?.content.map(block => 'text' in block ? block.text : '').join(''))
      .toContain('routed')
    expect(h.conductor.get(successorStub.agent)?.tasks[0]).toMatchObject({ status: 'done' })
  })

  it('caps the retained report history', async () => {
    const h = await harness({ reportHistoryLimit: 2 })
    const { ref, taskId } = boardWithTask(h)
    void ref
    await h.conductor.spawnWorkers(h.agent)
    const view = h.conductor.get(h.agent)
    const session = h.ctx.sessions.get(view?.tasks[0]?.assignee ?? SessionId('missing'))
    if (session === undefined) throw new Error('expected the worker session')
    const worker = liveAgentFor(h, session)
    for (let index = 0; index < 3; index += 1) {
      h.conductor.report(worker.agent, { taskId, status: 'progress', message: `note ${index}` })
    }
    const after = h.conductor.get(h.agent)
    expect(after?.tasks[0]?.reports).toHaveLength(2)
    expect(after?.tasks[0]?.reports.map(report => report.message)).toEqual(['note 1', 'note 2'])
  })

  it('keeps a blocked task blocked on a later progress report', async () => {
    const h = await harness()
    const { ref, taskId } = boardWithTask(h)
    void ref
    await h.conductor.spawnWorkers(h.agent)
    const view = h.conductor.get(h.agent)
    const session = h.ctx.sessions.get(view?.tasks[0]?.assignee ?? SessionId('missing'))
    if (session === undefined) throw new Error('expected the worker session')
    const worker = liveAgentFor(h, session)
    h.conductor.report(worker.agent, { taskId, status: 'blocked', message: 'stuck' })
    h.conductor.report(worker.agent, { taskId, status: 'progress', message: 'still trying' })
    const after = h.conductor.get(h.agent)
    expect(after?.tasks[0]).toMatchObject({ status: 'blocked' })
    expect(after?.tasks[0]?.reports).toHaveLength(2)
  })
})

describe('worker spawning', () => {
  it('spawns one worker at a time in serial mode and marks the task in-progress', async () => {
    const h = await harness()
    const { ref, taskId } = boardWithTask(h)
    void ref
    const spawned = await h.conductor.spawnWorkers(h.agent)
    expect(spawned).toHaveLength(1)
    expect(spawned[0]?.taskId).toBe(taskId)
    expect(h.startContinuable).toHaveBeenCalledTimes(1)
    const spec = h.startContinuable.mock.calls[0]?.[0] as unknown as {
      provider: string
      label: string
      request: { persona: string; prompt: Array<{ text: string }>; toolFilter: { deny: string[] } }
    }
    expect(spec.provider).toBe('spawn')
    expect(spec.label).toBe('write module')
    expect(spec.request.persona).toContain('subtask worker')
    expect(spec.request.persona).toContain('Never contact sibling workers directly')
    expect(spec.request.prompt[0]?.text).toContain('Do not contact sibling workers directly')
    expect(spec.request.prompt[0]?.text).toContain('report any cross-task context to the conductor')
    expect(spec.request.toolFilter.deny).toContain('conductor_init')
    expect(spec.request.toolFilter.deny).not.toContain('task_report')
    const view = h.conductor.get(h.agent)
    expect(view?.tasks[0]).toMatchObject({ status: 'in-progress', assignee: spawned[0]?.workerId })
    // A second pass spawns nothing while the task is in progress.
    expect(await h.conductor.spawnWorkers(h.agent)).toHaveLength(0)
  })

  it('names worker windows by their task title', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionTitleService, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 })
    fakeSubagents(ctx)
    await ctx.plugin(ConductorService)
    const session = ctx.sessions.create(SessionId(`conductor-title-${Math.random()}`), {
      meta: { cwd: process.cwd() },
    })
    const stub = stubAgentForSession(session)
    ctx.agents.register(stub.agent)
    const init = ctx.conductor.init(stub.agent, { objective: 'a', mode: 'serial' })
    ctx.conductor.createTask(stub.agent, { id: init.id, revision: init.revision }, { title: '写物理引擎', description: 'd' })
    await ctx.conductor.spawnWorkers(stub.agent)
    const view = ctx.conductor.get(stub.agent)
    const workerId = view?.tasks[0]?.assignee
    if (workerId === undefined) throw new Error('expected a worker session')
    const workerSession = ctx.sessions.get(workerId)
    if (workerSession === undefined) throw new Error('expected the worker session')
    const titles = workerSession.events
      .filter(event => event.type === 'session/title')
      .map(event => (event.data as { title: string }).title)
    expect(titles).toEqual(['写物理引擎'])
  })

  it('tolerates failing worker title writes', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionTitleService, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 })
    fakeSubagents(ctx)
    await ctx.plugin(ConductorService)
    const session = ctx.sessions.create(SessionId(`conductor-title-fail-${Math.random()}`), {
      meta: { cwd: process.cwd() },
    })
    const stub = stubAgentForSession(session)
    ctx.agents.register(stub.agent)
    const init = ctx.conductor.init(stub.agent, { objective: 'a', mode: 'parallel', maxParallelWorkers: 2 })
    ctx.conductor.createTask(stub.agent, { id: init.id, revision: init.revision }, { title: 'one', description: 'd1' })
    const one = ctx.conductor.get(stub.agent)
    ctx.conductor.createTask(stub.agent, { id: init.id, revision: one?.revision ?? init.revision }, { title: 'two', description: 'd2' })
    // An Error and a non-Error throw each exercise one render path of the
    // contained failure log; neither write blocks the spawn.
    const spy = vi.spyOn(ctx.sessionTitle, 'rename')
      .mockImplementationOnce(() => { throw new Error('title store unavailable') })
      .mockImplementationOnce(() => { throw 'title store unavailable' })
    await ctx.conductor.spawnWorkers(stub.agent)
    spy.mockRestore()
    expect(ctx.conductor.get(stub.agent)?.tasks.map(task => task.status)).toEqual(['in-progress', 'in-progress'])
  })

  it('holds the next ready task while a serial worker is still in progress', async () => {
    const h = await harness()
    const init = h.conductor.init(h.agent, { objective: 'a', mode: 'serial' })
    h.conductor.createTask(h.agent, { id: init.id, revision: init.revision }, { title: 'one', description: 'd1' })
    const one = h.conductor.get(h.agent)
    h.conductor.createTask(h.agent, { id: init.id, revision: one?.revision ?? init.revision }, { title: 'two', description: 'd2' })
    const first = await h.conductor.spawnWorkers(h.agent)
    expect(first).toHaveLength(1)
    // Task two is ready but serial mode holds it while task one runs.
    expect(await h.conductor.spawnWorkers(h.agent)).toHaveLength(0)
    const view = h.conductor.get(h.agent)
    expect(view?.tasks[1]).toMatchObject({ status: 'todo' })
  })

  it('includes prior worker reports in a reassigned task briefing', async () => {
    const h = await harness()
    const { ref, taskId } = boardWithTask(h)
    void ref
    await h.conductor.spawnWorkers(h.agent)
    const view = h.conductor.get(h.agent)
    const session = h.ctx.sessions.get(view?.tasks[0]?.assignee ?? SessionId('missing'))
    if (session === undefined) throw new Error('expected the worker session')
    const worker = liveAgentFor(h, session)
    h.conductor.report(worker.agent, { taskId, status: 'blocked', message: 'stuck here' })
    const after = h.conductor.get(h.agent)
    if (after === undefined) throw new Error('expected a board')
    h.conductor.reassignTask(h.agent, { id: after.id, revision: after.revision }, taskId)
    await h.conductor.spawnWorkers(h.agent)
    const spec = h.startContinuable.mock.calls[1]?.[0] as unknown as { request: { prompt: Array<{ text: string }> } }
    expect(spec.request.prompt[0]?.text).toContain('Previous worker reports for this task')
    expect(spec.request.prompt[0]?.text).toContain('stuck here')
  })

  it('renders a workspace line and a populated plan outline in worker briefings', async () => {
    const h = await harness()
    const init = h.conductor.init(h.agent, { objective: 'build', planOutline: 'step one' })
    const created = h.conductor.createTask(h.agent, { id: init.id, revision: init.revision }, {
      title: 'write module',
      description: 'write the module',
    })
    void created
    await h.conductor.spawnWorkers(h.agent)
    const spec = h.startContinuable.mock.calls[0]?.[0] as unknown as { request: { prompt: Array<{ text: string }> } }
    expect(spec.request.prompt[0]?.text).toContain('Plan outline: step one')
  })

  it('spawns ready tasks up to the parallel cap and respects dependencies', async () => {
    const h = await harness()
    const init = h.conductor.init(h.agent, { objective: 'a', mode: 'parallel', maxParallelWorkers: 2 })
    const one = h.conductor.createTask(h.agent, { id: init.id, revision: init.revision }, { title: 'one', description: 'd1' })
    const idOne = one.tasks[0]?.id ?? TaskId('missing')
    const two = h.conductor.createTask(h.agent, { id: one.id, revision: one.revision }, { title: 'two', description: 'd2' })
    const idTwo = two.tasks[1]?.id ?? TaskId('missing')
    h.conductor.createTask(h.agent, { id: two.id, revision: two.revision }, {
      title: 'three',
      description: 'd3',
      dependsOn: [idOne],
    })
    const spawned = await h.conductor.spawnWorkers(h.agent)
    // one and two are ready; three depends on one. Cap 2 admits both ready tasks.
    expect(spawned.map(entry => entry.taskId)).toEqual([idOne, idTwo])
    const view = h.conductor.get(h.agent)
    expect(view?.tasks[2]).toMatchObject({ status: 'todo' })
    // A worker report on a multi-task board exercises the non-matching map arm.
    const firstSession = h.ctx.sessions.get(spawned[0]?.workerId ?? SessionId('missing'))
    if (firstSession === undefined) throw new Error('expected the worker session')
    const worker = liveAgentFor(h, firstSession)
    h.conductor.report(worker.agent, { taskId: idOne, status: 'done', message: 'built' })
    expect(h.conductor.get(h.agent)?.tasks[0]).toMatchObject({ status: 'done' })
  })

  it('marks tasks with blocked dependencies as blocked', async () => {
    const h = await harness()
    const init = h.conductor.init(h.agent, { objective: 'a' })
    const one = h.conductor.createTask(h.agent, { id: init.id, revision: init.revision }, { title: 'one', description: 'd1' })
    const idOne = one.tasks[0]?.id ?? TaskId('missing')
    const two = h.conductor.createTask(h.agent, { id: one.id, revision: one.revision }, {
      title: 'two',
      description: 'd2',
      dependsOn: [idOne],
    })
    h.conductor.setTaskStatus(h.agent, { id: two.id, revision: two.revision }, idOne, 'blocked', {
      code: 'model-reported',
      message: 'stuck',
    })
    const spawned = await h.conductor.spawnWorkers(h.agent)
    expect(spawned).toHaveLength(0)
    const view = h.conductor.get(h.agent)
    expect(view?.tasks[1]).toMatchObject({ status: 'blocked', blockedReason: { code: 'dependency-blocked' } })
  })

  it('refuses to schedule a paused board and reports spawn failures', async () => {
    const h = await harness()
    const { ref } = boardWithTask(h)
    h.conductor.pause(h.agent, ref)
    await expect(h.conductor.spawnWorkers(h.agent)).rejects.toMatchObject({
      code: 'CONDUCTOR_INVALID_TRANSITION',
    })
    h.conductor.resume(h.agent, { id: ref.id, revision: ref.revision + 1 })
    h.startContinuable.mockRejectedValueOnce(new Error('provider down'))
    await expect(h.conductor.spawnWorkers(h.agent)).rejects.toMatchObject({
      code: 'CONDUCTOR_SPAWN_FAILED',
    })
  })

  it('renders a non-Error spawn failure into the spawn error', async () => {
    const h = await harness()
    const { ref } = boardWithTask(h)
    void ref
    h.startContinuable.mockRejectedValueOnce('provider down')
    const spawning = h.conductor.spawnWorkers(h.agent)
    await expect(spawning).rejects.toMatchObject({ code: 'CONDUCTOR_SPAWN_FAILED' })
    await expect(spawning).rejects.toThrow('provider down')
  })
})

describe('conductor messaging and handover', () => {
  it('delivers a message to a live assigned worker', async () => {
    const h = await harness()
    const { ref, taskId } = boardWithTask(h)
    void taskId
    await h.conductor.spawnWorkers(h.agent)
    const view = h.conductor.get(h.agent)
    const session = h.ctx.sessions.get(view?.tasks[0]?.assignee ?? SessionId('missing'))
    if (session === undefined) throw new Error('expected the worker session')
    const worker = liveAgentFor(h, session)
    const delivered = await h.conductor.deliver(h.agent, session.id, ' please continue ')
    expect(delivered.messageId).toBeTruthy()
    expect(worker.followups).toHaveLength(1)
    const text = worker.followups[0]?.content.map(block => 'text' in block ? block.text : '').join('')
    expect(text).toBe('please continue')
    void ref
  })

  it('rejects delivery to a session that is not an assignee', async () => {
    const h = await harness()
    h.conductor.init(h.agent, { objective: 'a' })
    await expect(h.conductor.deliver(h.agent, SessionId('nobody'), 'hi'))
      .rejects.toMatchObject({ code: 'CONDUCTOR_WORKER_NOT_FOUND' })
  })

  it('rejects cold-resume delivery when the caller is not the durable parent', async () => {
    const h = await harness()
    const { ref } = boardWithTask(h)
    void ref
    await h.conductor.spawnWorkers(h.agent)
    const view = h.conductor.get(h.agent)
    const workerId = view?.tasks[0]?.assignee
    if (workerId === undefined) throw new Error('expected the worker session')
    // Detach the worker session from the store: a disposed window is not live.
    const session = h.ctx.sessions.get(workerId)
    if (session === undefined) throw new Error('expected the worker session')
    const alien = workerSession(h, 'alien-child')
    h.ctx.sessions.create(SessionId('alien-child'), {
      meta: { parentSession: SessionId('some-other-parent'), origin: 'subagent', delegationDepth: 1 },
    })
    void session
    void alien
    await expect(h.conductor.deliver(h.agent, SessionId('alien-child'), 'hi'))
      .rejects.toMatchObject({ code: 'CONDUCTOR_WORKER_NOT_FOUND' })
  })

  it('hands over to a fresh window: transfers the board and retires this one', async () => {
    const h = await harness()
    const init = h.conductor.init(h.agent, { objective: 'build', mode: 'parallel', planOutline: 'the plan' })
    const created = h.conductor.createTask(h.agent, { id: init.id, revision: init.revision }, {
      title: 'write module',
      description: 'write the module',
    })
    const taskId = created.tasks[0]?.id ?? TaskId('missing')
    await h.conductor.spawnWorkers(h.agent)
    const view = h.conductor.get(h.agent)
    const workerId = view?.tasks[0]?.assignee
    if (workerId === undefined) throw new Error('expected the worker session')
    const session = h.ctx.sessions.get(workerId)
    if (session === undefined) throw new Error('expected the worker session')
    const worker = liveAgentFor(h, session)
    h.conductor.report(worker.agent, { taskId, status: 'blocked', message: 'stuck' })
    const before = h.conductor.get(h.agent)
    if (before === undefined) throw new Error('expected a board')
    const handed = await h.conductor.handover(h.agent, '  too many compactions  ')
    expect(h.startContinuable).toHaveBeenCalledTimes(2)
    const spec = h.startContinuable.mock.calls[1]?.[0] as unknown as { label: string; request: { prompt: Array<{ text: string }> } }
    expect(spec.label).toBe('conductor-handover')
    expect(spec.request.prompt[0]?.text).toContain('new conductor window')
    expect(spec.request.prompt[0]?.text).toContain('too many compactions')
    expect(spec.request.prompt[0]?.text).toContain('(max 3 parallel workers)')
    expect(spec.request.prompt[0]?.text).toContain('assignee=')
    expect(spec.request.prompt[0]?.text).toContain('blocked(worker-blocked: stuck)')
    expect(spec.request.prompt[0]?.text).toContain('reports=1')
    // The successor session owns the transferred board.
    const successorSession = h.ctx.sessions.get(handed.childId)
    if (successorSession === undefined) throw new Error('expected the successor session')
    expect(successorSession.events.filter(event => event.type === 'conductor/change')).toHaveLength(1)
    const successor = liveAgentFor(h, successorSession)
    const successorBoard = h.conductor.get(successor.agent)
    expect(successorBoard).toMatchObject({
      id: before.id,
      revision: before.revision + 1,
      conductorSessionId: handed.childId,
      handoverCount: 1,
      activation: 'armed',
    })
    expect(successorBoard?.tasks).toHaveLength(1)
    // The retiring session's log carries the same change and the window
    // loses its mutation authority.
    const retiringChanges = h.session.events.filter(event => event.type === 'conductor/change')
    expect(retiringChanges).toHaveLength(5)
    expect(retiringChanges.at(-1)).toMatchObject({ data: { operation: 'handover' } })
    expect(h.conductor.get(h.agent)).toMatchObject({ conductorSessionId: handed.childId, activation: 'disarmed' })
    expect(() => h.conductor.createTask(h.agent, { id: before.id, revision: before.revision + 1 }, {
      title: 'x',
      description: 'y',
    })).toThrow(expect.objectContaining({ code: 'CONDUCTOR_NOT_CONDUCTOR' }))
  })

  it('rebases a handover on worker reports committed while child startup is pending', async () => {
    const h = await harness()
    const { taskId } = boardWithTask(h)
    await h.conductor.spawnWorkers(h.agent)
    const assigned = h.conductor.get(h.agent)?.tasks[0]?.assignee
    if (assigned === undefined) throw new Error('expected an assigned worker')
    const workerSession = h.ctx.sessions.get(assigned)
    if (workerSession === undefined) throw new Error('expected the worker session')
    const worker = liveAgentFor(h, workerSession)

    let releaseStart!: () => void
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve })
    h.startContinuable.mockImplementationOnce(async (spec) => {
      await startGate
      const childId = SessionId('child-conductor-handover-race')
      h.ctx.sessions.create(childId, {
        meta: {
          parentSession: spec.request.parent.session.id,
          origin: 'subagent',
          delegationDepth: 1,
        },
      })
      return { childId, messageId: 'message-handover-race' as MessageId }
    })

    const handing = h.conductor.handover(h.agent, 'refresh the conductor')
    await vi.waitFor(() => { expect(h.startContinuable).toHaveBeenCalledTimes(2) })
    h.conductor.report(worker.agent, { taskId, status: 'progress', message: 'landed during handover' })
    const reported = h.conductor.get(h.agent)
    if (reported === undefined) throw new Error('expected the reported board')

    releaseStart()
    const handed = await handing
    const successorSession = h.ctx.sessions.get(handed.childId)
    if (successorSession === undefined) throw new Error('expected the successor session')
    const successor = liveAgentFor(h, successorSession)
    const successorBoard = h.conductor.get(successor.agent)

    expect(successorBoard).toMatchObject({
      revision: reported.revision + 1,
      conductorSessionId: handed.childId,
      activation: 'armed',
    })
    expect(successorBoard?.tasks[0]?.reports.at(-1)?.message).toBe('landed during handover')
    expect(h.conductor.get(h.agent)).toMatchObject({
      revision: reported.revision + 1,
      conductorSessionId: handed.childId,
      activation: 'disarmed',
    })
  })

  it('rejects handover from a non-active board or without a reason', async () => {
    const h = await harness()
    const init = h.conductor.init(h.agent, { objective: 'a' })
    const ref = { id: init.id, revision: init.revision }
    h.conductor.pause(h.agent, ref)
    await expect(h.conductor.handover(h.agent, 'reason'))
      .rejects.toMatchObject({ code: 'CONDUCTOR_INVALID_TRANSITION' })
    h.conductor.resume(h.agent, { id: init.id, revision: init.revision + 1 })
    await expect(h.conductor.handover(h.agent, '  '))
      .rejects.toMatchObject({ code: 'CONDUCTOR_INVALID_HANDOVER' })
  })

  it('rejects a handover whose board left active while the child was starting', async () => {
    const h = await harness()
    const init = h.conductor.init(h.agent, { objective: 'a' })
    // Park the child startup, move the board out of active, then release:
    // the handover must rebase onto the latest board and refuse to transfer.
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    h.startContinuable.mockImplementationOnce(() => gate.then(() => ({
      childId: SessionId('late-handover-child'),
      messageId: 'late-handover-message' as MessageId,
    })))
    const handing = h.conductor.handover(h.agent, 'quality')
    await vi.waitFor(() => {
      expect(h.startContinuable).toHaveBeenCalledTimes(1)
    })
    h.conductor.complete(h.agent, { id: init.id, revision: init.revision })
    release?.()
    await expect(handing).rejects.toMatchObject({ code: 'CONDUCTOR_INVALID_TRANSITION' })
  })

  it('re-arms the current conductor on a session-start edge', async () => {
    const h = await harness()
    const view = h.conductor.init(h.agent, { objective: 'a' })
    agentEvents(h.ctx, h.agent).emit('agent/session-start', { source: 'resume' })
    expect(h.conductor.get(h.agent)).toMatchObject({ activation: 'armed' })
    h.conductor.pause(h.agent, { id: view.id, revision: view.revision })
    agentEvents(h.ctx, h.agent).emit('agent/session-start', { source: 'resume' })
    expect(h.conductor.get(h.agent)).toMatchObject({ activation: 'disarmed' })
  })

  it('disarms on demand without changing durable state', async () => {
    const h = await harness()
    const view = h.conductor.init(h.agent, { objective: 'a' })
    const disarmed = h.conductor.disarm(h.agent)
    expect(disarmed).toMatchObject({ id: view.id, activation: 'disarmed' })
    expect(h.session.events).toHaveLength(1)
  })

  it('cold-resumes a direct-parent worker through the subagent service', async () => {
    const h = await harness()
    const { ref } = boardWithTask(h)
    void ref
    await h.conductor.spawnWorkers(h.agent)
    const view = h.conductor.get(h.agent)
    const workerId = view?.tasks[0]?.assignee
    if (workerId === undefined) throw new Error('expected the worker session')
    const delivered = await h.conductor.deliver(h.agent, workerId, 'wake up')
    expect(delivered.messageId).toBe('cold-resumed-message')
  })

  it('rejects delivery with blank text and a missing conductor agent on report', async () => {
    const h = await harness()
    const { ref, taskId } = boardWithTask(h)
    void ref
    await h.conductor.spawnWorkers(h.agent)
    const view = h.conductor.get(h.agent)
    const workerId = view?.tasks[0]?.assignee
    if (workerId === undefined) throw new Error('expected the worker session')
    const session = h.ctx.sessions.get(workerId)
    if (session === undefined) throw new Error('expected the worker session')
    const worker = liveAgentFor(h, session)
    await expect(h.conductor.deliver(h.agent, workerId, '   '))
      .rejects.toMatchObject({ code: 'CONDUCTOR_INVALID_REPORT' })
    // Detach the conductor agent from the registry: reports then fail loud.
    const realGet = h.ctx.agents.get.bind(h.ctx.agents)
    const spy = vi.spyOn(h.ctx.agents, 'get').mockImplementation(id =>
      id === h.session.id ? undefined : realGet(id))
    expect(() => h.conductor.report(worker.agent, { taskId, status: 'done', message: 'x' }))
      .toThrow(expect.objectContaining({ code: 'CONDUCTOR_CONDUCTOR_NOT_LIVE' }))
    spy.mockRestore()
  })

  it('rejects a report from a worker whose parent chain ends nowhere', async () => {
    const h = await harness()
    const init = h.conductor.init(h.agent, { objective: 'a' })
    void init
    const orphanSession = Session.create(SessionId('orphan-worker'), undefined, {
      version: 0,
      id: SessionId('orphan-worker'),
      createdAt: Date.now(),
      origin: 'subagent',
      delegationDepth: 1,
    })
    const orphan = liveAgentFor(h, orphanSession)
    expect(() => h.conductor.report(orphan.agent, { taskId: TaskId('task-x'), status: 'done', message: 'x' }))
      .toThrow(expect.objectContaining({ code: 'CONDUCTOR_CONDUCTOR_NOT_LIVE' }))
  })

  it('rejects cold-resume delivery from a successor to an old worker', async () => {
    const h = await harness()
    const { ref, taskId } = boardWithTask(h)
    void ref
    void taskId
    await h.conductor.spawnWorkers(h.agent)
    const view = h.conductor.get(h.agent)
    const workerId = view?.tasks[0]?.assignee
    if (workerId === undefined) throw new Error('expected the worker session')
    const handed = await h.conductor.handover(h.agent, 'quality')
    const successorSession = h.ctx.sessions.get(handed.childId)
    if (successorSession === undefined) throw new Error('expected the successor session')
    const successor = liveAgentFor(h, successorSession)
    // The worker's durable parent is the retired window, not the successor.
    await expect(h.conductor.deliver(successor.agent, workerId, 'hi'))
      .rejects.toMatchObject({ code: 'CONDUCTOR_WORKER_NOT_FOUND' })
  })

  it('rejects a handover whose successor session does not exist', async () => {
    const h = await harness()
    const init = h.conductor.init(h.agent, { objective: 'a' })
    void init
    h.startContinuable.mockResolvedValueOnce({ childId: SessionId('ghost-child'), messageId: 'm' as MessageId })
    await expect(h.conductor.handover(h.agent, 'reason'))
      .rejects.toMatchObject({ code: 'CONDUCTOR_INVALID_HANDOVER' })
  })

  it('renders unassigned tasks and a missing plan outline in the handover briefing', async () => {
    const h = await harness()
    const init = h.conductor.init(h.agent, { objective: 'a', mode: 'serial' })
    h.conductor.createTask(h.agent, { id: init.id, revision: init.revision }, { title: 'one', description: 'd' })
    await h.conductor.handover(h.agent, 'quality')
    const spec = h.startContinuable.mock.calls[0]?.[0] as unknown as { request: { prompt: Array<{ text: string }> } }
    expect(spec.request.prompt[0]?.text).toContain('(none)')
    expect(spec.request.prompt[0]?.text).toContain('- task-')
  })

  it('rejects invalid service configuration', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    fakeSubagents(ctx)
    await expect(ctx.plugin(ConductorService, { maxParallelWorkers: 0 }))
      .rejects.toThrow('maxParallelWorkers must be a positive safe integer')
  })

  it('applies every deployment default when no config is supplied', async () => {
    const h = await harness()
    void h
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    fakeSubagents(ctx)
    await ctx.plugin(ConductorService)
    const session = ctx.sessions.create(SessionId('defaults-conductor'))
    const stub = stubAgentForSession(session)
    ctx.agents.register(stub.agent)
    const view = ctx.conductor.init(stub.agent, { objective: 'a', mode: 'parallel' })
    expect(view.maxParallelWorkers).toBe(3)
  })

  it('also resolves the defaults when constructed directly without config normalization', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    fakeSubagents(ctx)
    // Direct construction bypasses Cordis config normalization, exercising
    // the in-constructor defaults exactly like a config-less Loader row.
    const conductor = new ConductorService(ctx)
    const session = ctx.sessions.create(SessionId('direct-conductor'))
    const stub = stubAgentForSession(session)
    ctx.agents.register(stub.agent)
    const view = conductor.init(stub.agent, { objective: 'a', mode: 'parallel' })
    expect(view.maxParallelWorkers).toBe(3)
    expect(view.planOutline).toBe('')
  })

  it('rejects a string block reason and non-string report inputs', async () => {
    const h = await harness()
    const init = h.conductor.init(h.agent, { objective: 'a' })
    const created = h.conductor.createTask(h.agent, { id: init.id, revision: init.revision }, { title: 'one', description: 'd' })
    const idOne = created.tasks[0]?.id ?? TaskId('missing')
    expect(() => h.conductor.setTaskStatus(h.agent, { id: created.id, revision: created.revision }, idOne, 'blocked', 'stuck'))
      .toThrow(expect.objectContaining({ code: 'CONDUCTOR_INVALID_BLOCK_REASON' }))
    await h.conductor.spawnWorkers(h.agent)
    const view = h.conductor.get(h.agent)
    const session = h.ctx.sessions.get(view?.tasks[0]?.assignee ?? SessionId('missing'))
    if (session === undefined) throw new Error('expected the worker session')
    const worker = liveAgentFor(h, session)
    expect(() => h.conductor.report(worker.agent, { taskId: idOne, status: 'done', message: 42 as never }))
      .toThrow(expect.objectContaining({ code: 'CONDUCTOR_INVALID_REPORT' }))
  })

  it('rejects non-string deliver and handover inputs', async () => {
    const h = await harness()
    const init = h.conductor.init(h.agent, { objective: 'a' })
    void init
    await expect(h.conductor.deliver(h.agent, SessionId('nobody'), 42 as never))
      .rejects.toMatchObject({ code: 'CONDUCTOR_INVALID_REPORT' })
    await expect(h.conductor.handover(h.agent, 42 as never))
      .rejects.toMatchObject({ code: 'CONDUCTOR_INVALID_HANDOVER' })
  })

  it('rejects a self-dependency when editing a task', async () => {
    const { conductor, agent } = await harness()
    const init = conductor.init(agent, { objective: 'a' })
    const created = conductor.createTask(agent, { id: init.id, revision: init.revision }, { title: 'one', description: 'd' })
    const idOne = created.tasks[0]?.id ?? TaskId('missing')
    expect(() => conductor.editTask(agent, { id: created.id, revision: created.revision }, idOne, {
      dependsOn: [idOne],
    })).toThrow(expect.objectContaining({ code: 'CONDUCTOR_TASK_DEPENDENCY' }))
  })

  it('accepts a diamond dependency edit and exercises the visited set', async () => {
    const { conductor, agent } = await harness()
    const init = conductor.init(agent, { objective: 'a' })
    const one = conductor.createTask(agent, { id: init.id, revision: init.revision }, { title: 'one', description: 'd1' })
    const idOne = one.tasks[0]?.id ?? TaskId('missing')
    const two = conductor.createTask(agent, { id: one.id, revision: one.revision }, {
      title: 'two',
      description: 'd2',
      dependsOn: [idOne],
    })
    const idTwo = two.tasks[1]?.id ?? TaskId('missing')
    const three = conductor.createTask(agent, { id: two.id, revision: two.revision }, { title: 'three', description: 'd3' })
    const idThree = three.tasks[2]?.id ?? TaskId('missing')
    const edited = conductor.editTask(agent, { id: three.id, revision: three.revision }, idThree, {
      dependsOn: [idOne, idTwo],
    })
    expect(edited.tasks[2]).toMatchObject({ dependsOn: [idOne, idTwo] })
  })
})

/** Mount the services plus a file-backed settings provider over an empty document. */
async function harnessWithSettings(): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const home = await mkdtemp(join(tmpdir(), 'dsh-conductor-settings-'))
  const settingsFile = join(home, 'settings.yaml')
  await writeFile(settingsFile, '{}\n')
  await ctx.plugin(FileSettingsProvider, { path: settingsFile, watch: false })
  const { startContinuable } = fakeSubagents(ctx)
  await ctx.plugin(ConductorService)
  const session = ctx.sessions.create(SessionId(`conductor-settings-${Math.random()}`), {
    meta: { cwd: process.cwd() },
  })
  const stub = stubAgentForSession(session)
  ctx.agents.register(stub.agent)
  return {
    ctx,
    conductor: ctx.conductor,
    agent: stub.agent,
    session,
    followups: stub.followups,
    startContinuable,
  }
}

describe('the conductor scheduling mode as a user setting', () => {
  it('falls back to parallel while the user set none', async () => {
    const h = await harnessWithSettings()
    const init = h.conductor.init(h.agent, { objective: 'a' })
    expect(init.mode).toBe('parallel')
  })

  it('takes the user scheduling mode when the init names none', async () => {
    const h = await harnessWithSettings()
    await h.ctx.settings.update(settingsNamespace(CONDUCTOR_SETTINGS_NAMESPACE), { mode: 'serial' })
    const init = h.conductor.init(h.agent, { objective: 'a' })
    expect(init.mode).toBe('serial')
  })

  it('lets an explicit init mode override the user setting', async () => {
    const h = await harnessWithSettings()
    await h.ctx.settings.update(settingsNamespace(CONDUCTOR_SETTINGS_NAMESPACE), { mode: 'serial' })
    const init = h.conductor.init(h.agent, { objective: 'a', mode: 'parallel' })
    expect(init.mode).toBe('parallel')
  })

  it('hot-reloads a changed scheduling mode for the next board', async () => {
    const h = await harnessWithSettings()
    const first = h.conductor.init(h.agent, { objective: 'a' })
    expect(first.mode).toBe('parallel')
    h.conductor.complete(h.agent, { id: first.id, revision: first.revision })
    await h.ctx.settings.update(settingsNamespace(CONDUCTOR_SETTINGS_NAMESPACE), { mode: 'serial' })
    const second = h.conductor.init(h.agent, { objective: 'b' })
    expect(second.mode).toBe('serial')
  })
})
