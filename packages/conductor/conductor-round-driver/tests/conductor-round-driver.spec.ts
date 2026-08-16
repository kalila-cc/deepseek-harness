import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import ConductorService from '@deepseek-ai/dsh-conductor'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, MessageId, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as driverPlugin from '@deepseek-ai/dsh-conductor-round-driver'
import type { ContinuableStart } from '@deepseek-ai/dsh-subagent'

type ScriptEntry = StreamChunk[] | Error | 'hang' | ((options: GenerateOptions) => StreamChunk[])

/** Small request-recording adapter with controllable failure and cancellation. */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: ScriptEntry[]) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('ScriptedAdapter: script exhausted')
    if (entry instanceof Error) throw entry
    if (entry === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted) {
          reject(new Error('aborted'))
          return
        }
        options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
      return
    }
    const chunks = typeof entry === 'function' ? entry(options) : entry
    for (const chunk of chunks) yield chunk
  }
}

/** One successful text response. */
function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

interface Harness {
  ctx: Context
  adapter: ScriptedAdapter
  conductor: Agent
  startContinuable: ReturnType<typeof vi.fn>
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(context => context.fiber.dispose()))
})

/** Mount a real loop with only its model scripted and a fake subagent service. */
async function harness(
  script: ScriptEntry[],
  driverConfig: driverPlugin.Config = {},
): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
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
  const followup = vi.fn(async (): Promise<MessageId> => 'cold-resumed-message' as MessageId)
  ctx.provide('subagents', { startContinuable, followup } as never)
  await ctx.plugin(ConductorService, { reportHistoryLimit: 8 })
  await ctx.plugin(driverPlugin, driverConfig)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new ScriptedAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const conductor = ctx.agentLoop.create(SessionId(`driver-conductor-${Math.random()}`), {
    provider: 'mock',
    model: 'mock',
  })
  return { ctx, adapter, conductor, startContinuable }
}

/** Await a specific number of dispatched model requests. */
async function waitForRequests(adapter: ScriptedAdapter, count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(adapter.requests).toHaveLength(count)
  })
}

/** Append one compaction summary event to a session. */
function appendCompaction(agent: Agent): void {
  agent.session.append('compaction/summary', {
    compactionId: CompactionId(`compaction-${agent.session.seq}`),
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

/** Emit the agent/error lifecycle edge the driver listens for. */
function agentError(ctx: Context, agent: Agent): void {
  agentEvents(ctx, agent).emit('agent/error', { turn: 1, step: 1, error: new Error('turn failed') })
}

/** Emit one queued next-turn message through the inbox-inserted edge. */
function queueTurn(ctx: Context, agent: Agent, text: string): void {
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
  agent.inbox.append('next-turn', message)
  agentEvents(ctx, agent).emit('agent/inbox/inserted', { message })
}

describe('conductor round driver', () => {
  it('spawns a worker for a ready task when the conductor goes idle', async () => {
    const { ctx, adapter, conductor, startContinuable } = await harness([textResponse('ok')])
    const init = ctx.conductor.init(conductor, { objective: 'build' })
    ctx.conductor.createTask(conductor, { id: init.id, revision: init.revision }, {
      title: 'one',
      description: 'first',
    })
    conductor.followup(createUserMessage({
      content: [{ type: 'text', text: 'go' }],
      source: { kind: 'user' },
    }))
    await waitForRequests(adapter, 1)
    await vi.waitFor(() => {
      expect(startContinuable).toHaveBeenCalledTimes(1)
    })
    const view = ctx.conductor.get(conductor)
    expect(view?.tasks[0]).toMatchObject({ status: 'in-progress' })
    expect(view?.activation).toBe('armed')
  })

  it('spawns ready tasks up to the parallel cap', async () => {
    const { ctx, adapter, conductor, startContinuable } = await harness([textResponse('ok')])
    const init = ctx.conductor.init(conductor, { objective: 'build', mode: 'parallel', maxParallelWorkers: 2 })
    ctx.conductor.createTask(conductor, { id: init.id, revision: init.revision }, { title: 'one', description: 'd1' })
    const one = ctx.conductor.get(conductor)
    ctx.conductor.createTask(conductor, { id: init.id, revision: one?.revision ?? init.revision }, { title: 'two', description: 'd2' })
    conductor.followup(createUserMessage({
      content: [{ type: 'text', text: 'go' }],
      source: { kind: 'user' },
    }))
    await waitForRequests(adapter, 1)
    await vi.waitFor(() => {
      expect(startContinuable).toHaveBeenCalledTimes(2)
    })
  })

  it('blocks the board and wakes the conductor when no task can proceed', async () => {
    const { ctx, adapter, conductor } = await harness([textResponse('ack')])
    const init = ctx.conductor.init(conductor, { objective: 'build' })
    const created = ctx.conductor.createTask(conductor, { id: init.id, revision: init.revision }, {
      title: 'one',
      description: 'first',
    })
    const taskId = created.tasks[0]?.id
    if (taskId === undefined) throw new Error('expected a task')
    ctx.conductor.setTaskStatus(conductor, { id: created.id, revision: created.revision }, taskId, 'blocked', {
      code: 'model-reported',
      message: 'stuck',
    })
    // The driver acts at conductor quiescence: blocking pass, then the
    // blocked notice wakes the conductor for one turn.
    await vi.waitFor(() => {
      const view = ctx.conductor.get(conductor)
      expect(view?.phase).toBe('blocked')
    })
    await waitForRequests(adapter, 1)
    const view = ctx.conductor.get(conductor)
    expect(view?.blockedReason).toMatchObject({ code: 'blocked-tasks' })
    expect(view?.activation).toBe('disarmed')
  })

  it('completes the board and wakes the conductor when every task is done', async () => {
    const { ctx, adapter, conductor } = await harness([textResponse('ack')])
    const init = ctx.conductor.init(conductor, { objective: 'build' })
    const created = ctx.conductor.createTask(conductor, { id: init.id, revision: init.revision }, {
      title: 'one',
      description: 'first',
    })
    const taskId = created.tasks[0]?.id
    if (taskId === undefined) throw new Error('expected a task')
    ctx.conductor.setTaskStatus(conductor, { id: created.id, revision: created.revision }, taskId, 'done')
    await vi.waitFor(() => {
      const view = ctx.conductor.get(conductor)
      expect(view?.phase).toBe('complete')
    })
    await waitForRequests(adapter, 1)
    const view = ctx.conductor.get(conductor)
    expect(view?.activation).toBe('disarmed')
  })

  it('hands the role over to a fresh window after too many compactions', async () => {
    const { ctx, adapter, conductor, startContinuable } = await harness(
      [textResponse('announce')],
      { handoverAfterCompactions: 2 },
    )
    const init = ctx.conductor.init(conductor, { objective: 'build' })
    appendCompaction(conductor)
    appendCompaction(conductor)
    await vi.waitFor(() => {
      expect(startContinuable).toHaveBeenCalledTimes(1)
    })
    const spec = startContinuable.mock.calls[0]?.[0] as { label: string }
    expect(spec.label).toBe('conductor-handover')
    // The retiring window lost its mandate; the successor session owns the board.
    const retired = ctx.conductor.get(conductor)
    expect(retired?.conductorSessionId).not.toBe(conductor.session.id)
    const successor = ctx.sessions.get(retired?.conductorSessionId ?? SessionId('missing'))
    expect(successor?.events.some(event =>
      event.type === 'conductor/change'
      && (event.data as { operation?: string }).operation === 'handover')).toBe(true)
    await waitForRequests(adapter, 1)
    void init
  })

  it('does not drive a retired conductor window', async () => {
    const { ctx, adapter, conductor, startContinuable } = await harness(
      [textResponse('announce')],
      { handoverAfterCompactions: 2 },
    )
    const init = ctx.conductor.init(conductor, { objective: 'build' })
    appendCompaction(conductor)
    appendCompaction(conductor)
    await waitForRequests(adapter, 1)
    await vi.waitFor(() => {
      expect(startContinuable).toHaveBeenCalledTimes(1)
    })
    const before = startContinuable.mock.calls.length
    // Give the driver a moment: a retired window must not spawn anything.
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(startContinuable.mock.calls.length).toBe(before)
    void init
  })

  it('blocks the board when a worker spawn fails', async () => {
    const { ctx, adapter, conductor, startContinuable } = await harness([textResponse('ack')])
    const init = ctx.conductor.init(conductor, { objective: 'build' })
    ctx.conductor.createTask(conductor, { id: init.id, revision: init.revision }, {
      title: 'one',
      description: 'first',
    })
    startContinuable.mockRejectedValueOnce(new Error('provider down'))
    await vi.waitFor(() => {
      const view = ctx.conductor.get(conductor)
      expect(view?.phase).toBe('blocked')
    })
    const view = ctx.conductor.get(conductor)
    expect(view?.blockedReason).toMatchObject({ code: 'spawn-failed' })
    await waitForRequests(adapter, 1)
    void init
  })

  it('blocks the board when a spawn rejects with a non-Error value', async () => {
    const { ctx, adapter, conductor, startContinuable } = await harness([textResponse('ack')])
    const init = ctx.conductor.init(conductor, { objective: 'build' })
    ctx.conductor.createTask(conductor, { id: init.id, revision: init.revision }, {
      title: 'one',
      description: 'first',
    })
    startContinuable.mockRejectedValueOnce('provider down')
    await vi.waitFor(() => {
      const view = ctx.conductor.get(conductor)
      expect(view?.phase).toBe('blocked')
    })
    const view = ctx.conductor.get(conductor)
    expect(view?.blockedReason).toMatchObject({ code: 'spawn-failed' })
    expect(view?.blockedReason?.message).toContain('provider down')
    await waitForRequests(adapter, 1)
    void init
  })

  it('keeps the board active when an automatic handover fails', async () => {
    const { ctx, adapter, conductor, startContinuable } = await harness(
      [textResponse('ok')],
      { handoverAfterCompactions: 1 },
    )
    const init = ctx.conductor.init(conductor, { objective: 'build' })
    appendCompaction(conductor)
    startContinuable.mockRejectedValueOnce(new Error('provider down'))
    await new Promise(resolve => setTimeout(resolve, 150))
    const view = ctx.conductor.get(conductor)
    expect(view).toMatchObject({ phase: 'active', conductorSessionId: conductor.session.id })
    void init
    void adapter
  })

  it('stops advancement when the durability checkpoint fails', async () => {
    const { ctx, adapter, conductor, startContinuable } = await harness([textResponse('ok')])
    const init = ctx.conductor.init(conductor, { objective: 'build' })
    ctx.conductor.createTask(conductor, { id: init.id, revision: init.revision }, {
      title: 'one',
      description: 'first',
    })
    ctx.on('session/flush', () => Promise.reject(new Error('disk unavailable')))
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(startContinuable).not.toHaveBeenCalled()
    void init
    void adapter
  })

  it('disarms the board when the agent reports an error', async () => {
    const { ctx, conductor } = await harness([textResponse('ok')])
    const init = ctx.conductor.init(conductor, { objective: 'build' })
    ctx.conductor.createTask(conductor, { id: init.id, revision: init.revision }, {
      title: 'one',
      description: 'first',
    })
    conductor.followup(createUserMessage({
      content: [{ type: 'text', text: 'go' }],
      source: { kind: 'user' },
    }))
    await vi.waitFor(() => {
      expect(ctx.conductor.get(conductor)?.tasks[0]).toMatchObject({ status: 'in-progress' })
    })
    agentError(ctx, conductor)
    expect(ctx.conductor.get(conductor)).toMatchObject({ activation: 'disarmed' })
    void init
  })

  it('rejects an invalid handover threshold configuration', async () => {
    await expect(harness([textResponse('ok')], { handoverAfterCompactions: 0 }))
      .rejects.toThrow('expected number >= 1 but got 0')
  })

  it('rejects an invalid threshold on direct apply', () => {
    const ctx = new Context()
    contexts.push(ctx)
    expect(() => {
      driverPlugin.apply(ctx, { handoverAfterCompactions: 0 })
    }).toThrow('handoverAfterCompactions must be a positive safe integer')
  })

  it('applies the default threshold on a direct apply without a field', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    const startContinuable = vi.fn()
    ctx.provide('subagents', { startContinuable, followup: vi.fn() } as never)
    await ctx.plugin(ConductorService)
    await ctx.plugin(AgentLoop, { agents: [] })
    // Direct apply bypasses Cordis config normalization, exercising the
    // in-function default exactly like a config-less Loader row.
    expect(() => { driverPlugin.apply(ctx, {}) }).not.toThrow()
  })

  it('contains a rejected driver task', async () => {
    const { ctx, adapter, conductor, startContinuable } = await harness([textResponse('ok')])
    const init = ctx.conductor.init(conductor, { objective: 'build' })
    ctx.conductor.createTask(conductor, { id: init.id, revision: init.revision }, {
      title: 'one',
      description: 'first',
    })
    await vi.waitFor(() => {
      expect(startContinuable).toHaveBeenCalledTimes(1)
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    const spy = vi.spyOn(ctx.agents, 'withoutInitiator').mockImplementationOnce(() =>
      Promise.reject(new Error('scheduler task rejected')))
    agentEvents(ctx, conductor).emit('agent/status', { status: 'idle' })
    await new Promise(resolve => setTimeout(resolve, 50))
    spy.mockRestore()
    expect(ctx.conductor.get(conductor)).toMatchObject({ phase: 'active' })
    void adapter
    void init
  })

  it('contains a synchronously failing driver start', async () => {
    const { ctx, adapter, conductor, startContinuable } = await harness([textResponse('ok')])
    const init = ctx.conductor.init(conductor, { objective: 'build' })
    ctx.conductor.createTask(conductor, { id: init.id, revision: init.revision }, {
      title: 'one',
      description: 'first',
    })
    await vi.waitFor(() => {
      expect(startContinuable).toHaveBeenCalledTimes(1)
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    const spy = vi.spyOn(ctx.agents, 'withoutInitiator').mockImplementationOnce(() => {
      throw new Error('start failed')
    })
    agentEvents(ctx, conductor).emit('agent/status', { status: 'idle' })
    await new Promise(resolve => setTimeout(resolve, 50))
    spy.mockRestore()
    expect(ctx.conductor.get(conductor)).toMatchObject({ phase: 'active' })
    void adapter
    void init
  })

  it('tolerates a failing board block on the blocked-tasks path', async () => {
    const { ctx, adapter, conductor, startContinuable } = await harness([textResponse('ok')])
    const init = ctx.conductor.init(conductor, { objective: 'build' })
    const created = ctx.conductor.createTask(conductor, { id: init.id, revision: init.revision }, {
      title: 'one',
      description: 'first',
    })
    const taskId = created.tasks[0]?.id
    if (taskId === undefined) throw new Error('expected a task')
    ctx.conductor.setTaskStatus(conductor, { id: created.id, revision: created.revision }, taskId, 'blocked', {
      code: 'model-reported',
      message: 'stuck',
    })
    const spy = vi.spyOn(ctx.conductor, 'block').mockImplementationOnce(() => {
      throw new Error('block failed')
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    spy.mockRestore()
    // The failed block was logged; the board stays active.
    expect(ctx.conductor.get(conductor)).toMatchObject({ phase: 'active' })
    expect(startContinuable).not.toHaveBeenCalled()
    void adapter
    void init
  })

  it('disarms an existing agent when the driver loads after it', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    const startContinuable = vi.fn()
    ctx.provide('subagents', { startContinuable, followup: vi.fn() } as never)
    await ctx.plugin(ConductorService)
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new ScriptedAdapter([textResponse('ok')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const conductor = ctx.agentLoop.create(SessionId(`driver-late-${Math.random()}`), {
      provider: 'mock',
      model: 'mock',
    })
    ctx.conductor.init(conductor, { objective: 'build' })
    const spy = vi.spyOn(ctx.conductor, 'disarm').mockImplementationOnce(() => {
      throw new Error('disarm failed')
    })
    // Loading the driver over an existing agent disarms its automatic
    // authority; a failing disarm is contained and logged.
    await ctx.plugin(driverPlugin, { handoverAfterCompactions: 4 })
    spy.mockRestore()
    expect(ctx.conductor.get(conductor)).toMatchObject({ activation: 'armed' })
    void adapter
  })

  it('tolerates a failing disarm during teardown', async () => {
    const { ctx, conductor } = await harness([textResponse('ok')])
    const init = ctx.conductor.init(conductor, { objective: 'build' })
    void init
    const spy = vi.spyOn(ctx.conductor, 'disarm').mockImplementation(() => {
      throw new Error('disarm failed')
    })
    await ctx.fiber.dispose()
    spy.mockRestore()
  })

  it('awaits an in-flight drive during teardown', async () => {
    const { ctx, conductor, startContinuable } = await harness([textResponse('ok')])
    const init = ctx.conductor.init(conductor, { objective: 'build' })
    ctx.conductor.createTask(conductor, { id: init.id, revision: init.revision }, {
      title: 'one',
      description: 'first',
    })
    // Park the spawn mid-flight so a driver task is live during teardown.
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    startContinuable.mockResolvedValueOnce(gate.then(() => ({
      childId: SessionId('late-child'),
      messageId: 'late-message' as MessageId,
    })))
    await new Promise(resolve => setTimeout(resolve, 100))
    const disposal = ctx.fiber.dispose()
    release?.()
    await disposal
  })

  it('parks driving while a competing turn is queued and resumes at idle', async () => {
    const { ctx, adapter, conductor, startContinuable } = await harness([textResponse('ok')])
    const init = ctx.conductor.init(conductor, { objective: 'build' })
    ctx.conductor.createTask(conductor, { id: init.id, revision: init.revision }, {
      title: 'one',
      description: 'first',
    })
    await vi.waitFor(() => {
      expect(startContinuable).toHaveBeenCalledTimes(1)
    })
    const view = ctx.conductor.get(conductor)
    if (view === undefined) throw new Error('expected a board')
    ctx.conductor.reassignTask(conductor, { id: view.id, revision: view.revision }, (() => { const id = view.tasks[0]?.id; if (id === undefined) throw new Error('expected a task'); return id })())
    // A queued next-turn message parks the pending drive until idle again.
    queueTurn(ctx, conductor, 'go')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(startContinuable).toHaveBeenCalledTimes(1)
    agentEvents(ctx, conductor).emit('agent/status', { status: 'idle' })
    await vi.waitFor(() => {
      expect(startContinuable).toHaveBeenCalledTimes(2)
    })
    void adapter
    void init
  })

  it('ignores non-next-turn inbox insertions', async () => {
    const { ctx, adapter, conductor, startContinuable } = await harness([textResponse('ok')])
    const init = ctx.conductor.init(conductor, { objective: 'build' })
    ctx.conductor.createTask(conductor, { id: init.id, revision: init.revision }, {
      title: 'one',
      description: 'first',
    })
    await vi.waitFor(() => {
      expect(startContinuable).toHaveBeenCalledTimes(1)
    })
    const message = createUserMessage({
      content: [{ type: 'text', text: 'steering' }],
      source: { kind: 'user' },
    })
    agentEvents(ctx, conductor).emit('agent/inbox/inserted', { message })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(startContinuable).toHaveBeenCalledTimes(1)
    void adapter
    void init
  })

  it('disposes agent state and stops driving a removed agent', async () => {
    const { ctx, adapter, conductor, startContinuable } = await harness([textResponse('ok')])
    const init = ctx.conductor.init(conductor, { objective: 'build' })
    ctx.conductor.createTask(conductor, { id: init.id, revision: init.revision }, {
      title: 'one',
      description: 'first',
    })
    await vi.waitFor(() => {
      expect(startContinuable).toHaveBeenCalledTimes(1)
    })
    agentEvents(ctx, conductor).emit('agent/disposed', {})
    const view = ctx.conductor.get(conductor)
    if (view === undefined) throw new Error('expected a board')
    ctx.conductor.reassignTask(conductor, { id: view.id, revision: view.revision }, (() => { const id = view.tasks[0]?.id; if (id === undefined) throw new Error('expected a task'); return id })())
    // The removed agent is no longer live, so a pending drive must not spawn.
    const realGet = ctx.agents.get.bind(ctx.agents)
    const spy = vi.spyOn(ctx.agents, 'get').mockImplementation(id =>
      id === conductor.session.id ? undefined : realGet(id))
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(startContinuable).toHaveBeenCalledTimes(1)
    spy.mockRestore()
    void adapter
    void init
  })

  it('disarms on agent error and tolerates a failing disarm', async () => {
    const { ctx, conductor } = await harness([textResponse('ok')])
    const init = ctx.conductor.init(conductor, { objective: 'build' })
    const spy = vi.spyOn(ctx.conductor, 'disarm').mockImplementation(() => {
      throw new Error('disarm failed')
    })
    agentError(ctx, conductor)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
    agentError(ctx, conductor)
    expect(ctx.conductor.get(conductor)).toMatchObject({ activation: 'disarmed' })
    void init
  })

  it('recovers after a driver task rejection', async () => {
    const { ctx, adapter, conductor, startContinuable } = await harness([textResponse('ok')])
    const init = ctx.conductor.init(conductor, { objective: 'build' })
    ctx.conductor.createTask(conductor, { id: init.id, revision: init.revision }, {
      title: 'one',
      description: 'first',
    })
    const realGet = ctx.conductor.get.bind(ctx.conductor)
    const spy = vi.spyOn(ctx.conductor, 'get').mockImplementationOnce(() => {
      throw new Error('read failed')
    })
    agentEvents(ctx, conductor).emit('agent/status', { status: 'idle' })
    await new Promise(resolve => setTimeout(resolve, 50))
    spy.mockRestore()
    void realGet
    agentEvents(ctx, conductor).emit('agent/status', { status: 'idle' })
    await vi.waitFor(() => {
      expect(startContinuable).toHaveBeenCalledTimes(1)
    })
    void adapter
    void init
  })

  it('tolerates a failing board completion', async () => {
    const { ctx, adapter, conductor, startContinuable } = await harness([textResponse('ok')])
    const init = ctx.conductor.init(conductor, { objective: 'build' })
    const created = ctx.conductor.createTask(conductor, { id: init.id, revision: init.revision }, {
      title: 'one',
      description: 'first',
    })
    const taskId = created.tasks[0]?.id
    if (taskId === undefined) throw new Error('expected a task')
    ctx.conductor.setTaskStatus(conductor, { id: created.id, revision: created.revision }, taskId, 'done')
    const spy = vi.spyOn(ctx.conductor, 'complete').mockImplementationOnce(() => {
      throw new Error('complete failed')
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    spy.mockRestore()
    // The failed completion was logged; the board stays active and unspawned.
    expect(ctx.conductor.get(conductor)).toMatchObject({ phase: 'active' })
    expect(startContinuable).not.toHaveBeenCalled()
    void adapter
    void init
  })

  it('tolerates a failing block after a spawn failure', async () => {
    const { ctx, adapter, conductor, startContinuable } = await harness([textResponse('ok')])
    const init = ctx.conductor.init(conductor, { objective: 'build' })
    ctx.conductor.createTask(conductor, { id: init.id, revision: init.revision }, {
      title: 'one',
      description: 'first',
    })
    // A non-Error throw exercises the String render path of the failure log.
    const spy = vi.spyOn(ctx.conductor, 'block').mockImplementationOnce(() => {
      throw 'block failed'
    })
    startContinuable.mockRejectedValueOnce(new Error('provider down'))
    await new Promise(resolve => setTimeout(resolve, 100))
    spy.mockRestore()
    expect(ctx.conductor.get(conductor)?.phase).toBe('active')
    void adapter
    void init
  })
})
