import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import ConductorService from '@deepseek-ai/dsh-conductor'
import { createUserMessage, CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as toolTaskReport from '@deepseek-ai/dsh-tool-task-report'

const testToolSignal = new AbortController().signal

interface StubAgent {
  readonly agent: Agent
  readonly session: Session
  readonly followups: string[]
  setStatus(status: AgentStatus): void
}

/** Build one registry-compatible live agent whose injections enter the durable inbox. */
function stubAgent(session: Session): StubAgent {
  let status: AgentStatus = 'running'
  const followups: string[] = []
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    get status() { return status },
    ctx: new Context(),
    send: () => {},
    followup(message) {
      followups.push(message.content.map(block => 'text' in block ? block.text : '').join(''))
    },
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject(input) {
      this.inbox.append('next-step', input)
    },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  return { agent, session, followups, setStatus(value) { status = value } }
}

/** Open one message-triggered turn with its accepted model-visible input. */
function openTurn(stub: StubAgent): number {
  const turn = stub.session.events
    .filter(event => event.type === 'turn/start')
    .reduce((max, event) => Math.max(max, event.data.turn), 0) + 1
  const message = createUserMessage({
    content: [{ type: 'text', text: 'prompt' }],
    source: { kind: 'user' },
  })
  stub.agent.inbox.append('next-turn', message)
  const claimed = stub.agent.inbox.claim('next-turn', turn)
  if (claimed.length === 0) throw new Error('expected queued turn input')
  stub.session.append('turn/start', { turn })
  for (const admitted of claimed) {
    stub.session.append('user/message', admitted, { surfaceOp: 'append' })
  }
  return turn
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(context => context.fiber.dispose()))
})

interface Harness {
  ctx: Context
  conductor: StubAgent
  worker: StubAgent
  taskId: string
}

async function harness(): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ToolRuntime)
  const startContinuable = vi.fn(async (spec: { label: string; request: { parent: Agent } }) => {
    const childId = `child-${spec.label}-1`
    ctx.sessions.create(SessionId(childId), {
      meta: {
        parentSession: spec.request.parent.session.id,
        origin: 'subagent',
        delegationDepth: 1,
      },
    })
    return { childId: SessionId(childId), messageId: 'm1' }
  })
  ctx.provide('subagents', { startContinuable, followup: vi.fn() } as never)
  await ctx.plugin(ConductorService)
  const fiber = await ctx.plugin(toolTaskReport)
  void fiber
  const conductorSession = ctx.sessions.create(SessionId(`report-conductor-${Math.random()}`))
  const conductor = stubAgent(conductorSession)
  ctx.agents.register(conductor.agent)
  // The conductor creates a board with one task and spawns its worker.
  const turn = openTurn(conductor)
  const init = ctx.conductor.init(conductor.agent, { objective: 'build' })
  const created = ctx.conductor.createTask(conductor.agent, { id: init.id, revision: init.revision }, {
    title: 'one',
    description: 'first',
  })
  const taskId = created.tasks[0]?.id ?? ''
  await ctx.conductor.spawnWorkers(conductor.agent)
  closeTurn(conductor, turn)
  const view = ctx.conductor.get(conductor.agent)
  const assignee = view?.tasks[0]?.assignee
  if (assignee === undefined) throw new Error('expected an assigned worker')
  const workerSession = ctx.sessions.get(assignee)
  if (workerSession === undefined) throw new Error('expected the worker session')
  const worker = stubAgent(workerSession)
  ctx.agents.register(worker.agent)
  return { ctx, conductor, worker, taskId }
}

/** Close the currently open test turn. */
function closeTurn(stub: StubAgent, turn: number): void {
  stub.session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** Execute one registered tool under an optional driver initiator. */
async function execute(
  ctx: Context,
  name: string,
  args: unknown,
  agent: Agent,
): Promise<ToolExecutionResult> {
  const run = () => ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${Math.random()}`),
    name,
    arguments: args,
    agent,
  })
  return ctx.agents.withInitiator(agent, run)
}

describe('task_report tool', () => {
  it('registers the tool and reports a completion that wakes the conductor', async () => {
    const { ctx, conductor, worker, taskId } = await harness()
    expect(ctx.tools.get('task_report')?.name).toBe('task_report')
    expect(ctx.tools.get('task_report')?.description).toContain('instead of contacting sibling workers')
    const turn = openTurn(worker)
    const result = await execute(ctx, 'task_report', { task_id: taskId, status: 'done', message: ' built it ' }, worker.agent)
    expect(result.isError).toBe(false)
    const view = ctx.conductor.get(conductor.agent)
    expect(view?.tasks[0]).toMatchObject({ status: 'done' })
    expect(conductor.followups).toHaveLength(1)
    expect(conductor.followups[0]).toContain('built it')
    expect(conductor.followups[0]).toContain('status: done')
    closeTurn(worker, turn)
  })

  it('rejects a session that is not the task assignee', async () => {
    const { ctx, conductor, worker, taskId } = await harness()
    const strangerSession = Session.create(SessionId('stranger-worker'), undefined, {
      version: 0,
      id: SessionId('stranger-worker'),
      createdAt: Date.now(),
      parentSession: conductor.session.id,
      origin: 'subagent',
      delegationDepth: 1,
    })
    const stranger = stubAgent(strangerSession)
    ctx.agents.register(stranger.agent)
    const turn = openTurn(stranger)
    const result = await execute(ctx, 'task_report', { task_id: taskId, status: 'done', message: 'mine' }, stranger.agent)
    expect(result.isError).toBe(true)
    closeTurn(stranger, turn)
    void worker
  })

  it('rejects an empty message and a report after done', async () => {
    const { ctx, conductor, worker, taskId } = await harness()
    const turn = openTurn(worker)
    const empty = await execute(ctx, 'task_report', { task_id: taskId, status: 'done', message: '   ' }, worker.agent)
    expect(empty.isError).toBe(true)
    const done = await execute(ctx, 'task_report', { task_id: taskId, status: 'done', message: 'finished' }, worker.agent)
    expect(done.isError).toBe(false)
    const again = await execute(ctx, 'task_report', { task_id: taskId, status: 'progress', message: 'again' }, worker.agent)
    expect(again.isError).toBe(true)
    closeTurn(worker, turn)
    void conductor
  })

  it('rejects an unknown task id', async () => {
    const { ctx, worker } = await harness()
    const turn = openTurn(worker)
    const result = await execute(ctx, 'task_report', { task_id: 'task-unknown', status: 'done', message: 'x' }, worker.agent)
    expect(result.isError).toBe(true)
    closeTurn(worker, turn)
  })

  it('rejects a blank task id and presents its call card', async () => {
    const { ctx, worker } = await harness()
    expect(ctx.tools.get('task_report')?.presentCall?.({ task_id: 'task-1', status: 'done', message: 'x' }))
      .toMatchObject({ title: 'Report task done' })
    const turn = openTurn(worker)
    const blank = await execute(ctx, 'task_report', { task_id: '   ', status: 'done', message: 'x' }, worker.agent)
    expect(blank.isError).toBe(true)
    closeTurn(worker, turn)
  })
})
