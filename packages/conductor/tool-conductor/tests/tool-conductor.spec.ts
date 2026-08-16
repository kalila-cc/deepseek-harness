import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import ConductorService from '@deepseek-ai/dsh-conductor'
import { createUserMessage, CallId } from '@deepseek-ai/dsh-llm'
import type { MessageId, MessageSource } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as toolConductor from '@deepseek-ai/dsh-tool-conductor'
import type { ContinuableStart } from '@deepseek-ai/dsh-subagent'

const testToolSignal = new AbortController().signal

interface StubAgent {
  readonly agent: Agent
  readonly session: Session
  setStatus(status: AgentStatus): void
}

/** Build one registry-compatible live agent whose injections enter the durable inbox. */
function stubAgent(rawId: string, header?: Session['header']): StubAgent {
  const session = Session.create(SessionId(rawId), undefined, header)
  let status: AgentStatus = 'running'
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    get status() { return status },
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject(input) {
      this.inbox.append('next-step', input)
    },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  return { agent, session, setStatus(value) { status = value } }
}

/** Build a live agent over an existing stored session, recording followups. */
function liveWorker(session: Session): StubAgent & { followups: string[] } {
  const stub = stubAgent(`tool-worker-${Math.random()}`)
  const followups: string[] = []
  const agent: Agent = {
    ...stub.agent,
    id: session.id,
    session,
    followup(message) {
      followups.push(message.content.map(block => 'text' in block ? block.text : '').join(''))
    },
  }
  return { agent, session, setStatus: (value) => { stub.setStatus(value) }, followups }
}

/** Build a live agent over an existing stored session. */
function liveAgent(session: Session): StubAgent {
  const stub = stubAgent(`tool-agent-${Math.random()}`)
  const agent: Agent = {
    ...stub.agent,
    id: session.id,
    session,
  }
  return { agent, session, setStatus: (value) => { stub.setStatus(value) } }
}

/** Open one message-triggered turn with its accepted model-visible input. */
function openTurn(stub: StubAgent, source: MessageSource, text = 'prompt'): number {
  const turn = stub.session.events
    .filter(event => event.type === 'turn/start')
    .reduce((max, event) => Math.max(max, event.data.turn), 0) + 1
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source,
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

/** Close the currently open test turn. */
function closeTurn(stub: StubAgent, turn: number): void {
  stub.session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(context => context.fiber.dispose()))
})

interface Harness {
  ctx: Context
  root: StubAgent
  startContinuable: ReturnType<typeof vi.fn>
}

async function harness(config: toolConductor.Config = {}): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ToolRuntime)
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
  await ctx.plugin(ConductorService)
  const fiber = await ctx.plugin(toolConductor, config)
  const rootSession = ctx.sessions.create(SessionId(`conductor-tool-root-${Math.random()}`))
  const root = liveAgent(rootSession)
  ctx.agents.register(root.agent)
  void fiber
  return { ctx, root, startContinuable }
}

/** Execute one registered tool under an optional driver initiator. */
async function execute(
  ctx: Context,
  name: string,
  args: unknown,
  agent?: Agent,
  initiator: Agent | undefined = agent,
): Promise<ToolExecutionResult> {
  const run = () => ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${Math.random()}`),
    name,
    arguments: args,
    ...agent === undefined ? {} : { agent },
  })
  return initiator === undefined ? run() : ctx.agents.withInitiator(initiator, run)
}

/** Parse the compact JSON returned by a successful conductor tool. */
function resultJson(result: ToolExecutionResult): Record<string, unknown> {
  expect(result.isError).toBe(false)
  if (result.isError) throw new Error('expected conductor tool success')
  const block = result.content[0]
  if (block?.type !== 'text') throw new Error('expected text tool result')
  const parsed = JSON.parse(block.text) as Record<string, unknown>
  expect(result.value).toEqual(parsed)
  return parsed
}

/** Read the returned board sub-object. */
function resultBoard(result: ToolExecutionResult): Record<string, unknown> {
  const board = resultJson(result)['board']
  if (typeof board !== 'object' || board === null) throw new Error('expected returned board')
  return board as Record<string, unknown>
}

/** Read the task rows of a returned board. */
function boardTasks(board: Record<string, unknown>): Array<Record<string, unknown>> {
  const tasks = board['tasks']
  if (!Array.isArray(tasks)) throw new Error('expected board tasks')
  return tasks as Array<Record<string, unknown>>
}

/** Read one required string field of a task row. */
function taskField(task: Record<string, unknown>, field: string): string {
  const value = task[field]
  if (typeof value !== 'string') throw new Error(`expected task ${field}`)
  return value
}

describe('conductor tool registration and guidance', () => {
  it('registers eight tools plus guidance and disposes all contributions', async () => {
    const { ctx } = await harness({ workerHandoverAfterCompactions: 5 })
    const names = ['conductor_init', 'task_board', 'task_create', 'task_update', 'conductor_update', 'task_schedule', 'conductor_message', 'conductor_handover']
    expect(names.map(name => ctx.tools.get(name)?.name)).toEqual(names)
    const section = (await ctx.systemPrompt.assemble()).sections.find(item => item.name === 'tool:conductor')
    expect(section?.text).toContain('conductor of an agent team')
    expect(section?.text).toContain('worker compactions >= 5')
    expect(section?.text).toContain('omitting mode')
    expect(section?.text).toContain('end your turn instead of polling')
    expect(section?.text).toContain('Workers never communicate directly')
    expect(section?.text).toContain('relay the actionable information yourself with conductor_message')
    expect(section?.text).not.toContain('with the objective, mode')
    expect(ctx.tools.get('task_board')?.description).toContain('Do not poll it while workers are in progress')
  })

  it('rejects tool calls without an open model turn', async () => {
    const { ctx, root } = await harness()
    const result = await execute(ctx, 'task_board', {}, root.agent)
    expect(result.isError).toBe(true)
  })
})

describe('board and task tools', () => {
  it('init creates an armed board and task_board reads it', async () => {
    const { ctx, root } = await harness()
    const turn = openTurn(root, { kind: 'user' })
    const init = await execute(ctx, 'conductor_init', { objective: 'build', mode: 'parallel', plan_outline: 'plan' }, root.agent)
    expect(resultBoard(init)).toMatchObject({ objective: 'build', mode: 'parallel', planOutline: 'plan', revision: 1 })
    const read = await execute(ctx, 'task_board', {}, root.agent)
    expect(resultBoard(read)).toMatchObject({ phase: 'active' })
    closeTurn(root, turn)
  })

  it('init rejects a delegated worker session', async () => {
    const { ctx } = await harness()
    const worker = stubAgent('tool-worker', {
      version: 0,
      id: SessionId('tool-worker'),
      createdAt: Date.now(),
      origin: 'subagent',
      delegationDepth: 1,
    })
    ctx.agents.register(worker.agent)
    const turn = openTurn(worker, { kind: 'user' })
    const result = await execute(ctx, 'conductor_init', { objective: 'x' }, worker.agent)
    expect(result.isError).toBe(true)
    closeTurn(worker, turn)
  })

  it('task_create adds tasks and task_update transitions them', async () => {
    const { ctx, root } = await harness()
    const turn = openTurn(root, { kind: 'user' })
    await execute(ctx, 'conductor_init', { objective: 'build' }, root.agent)
    const created = await execute(ctx, 'task_create', { tasks: [{ title: 'one', description: 'first' }] }, root.agent)
    const board = resultBoard(created)
    const tasks = boardTasks(board)
    if (tasks.length !== 1) throw new Error('expected one created task')
    const idOne = taskField(tasks[0] ?? {}, 'id')
    // The second call creates the second task with a dependency on the first.
    const createdTwo = await execute(ctx, 'task_create', {
      tasks: [{ title: 'two', description: 'second', depends_on: [idOne] }],
    }, root.agent)
    const boardTwo = resultBoard(createdTwo)
    const tasksTwo = boardTasks(boardTwo)
    if (tasksTwo.length !== 2) throw new Error('expected two tasks')
    expect(tasksTwo[1]).toMatchObject({ dependsOn: [idOne] })
    const idTwo = taskField(tasksTwo[1] ?? {}, 'id')
    const updated = await execute(ctx, 'task_update', { task_id: idTwo, action: 'blocked', reason: 'stuck' }, root.agent)
    const boardThree = resultBoard(updated)
    const tasksThree = boardTasks(boardThree)
    expect(tasksThree[1]).toMatchObject({ status: 'blocked' })
    const unblocked = await execute(ctx, 'task_update', { task_id: idTwo, action: 'unblock' }, root.agent)
    expect(boardTasks(resultBoard(unblocked))).toMatchObject([{ status: 'todo' }, { status: 'todo' }])
    closeTurn(root, turn)
  })

  it('creates several tasks in one call by chaining refs across the batch', async () => {
    const { ctx, root } = await harness()
    const turn = openTurn(root, { kind: 'user' })
    await execute(ctx, 'conductor_init', { objective: 'build' }, root.agent)
    const created = await execute(ctx, 'task_create', {
      tasks: [
        { title: 'one', description: 'first' },
        { title: 'two', description: 'second' },
      ],
    }, root.agent)
    const tasks = boardTasks(resultBoard(created))
    if (tasks.length !== 2) throw new Error('expected two tasks')
    expect(tasks[1]).toMatchObject({ title: 'two', status: 'todo' })
    closeTurn(root, turn)
  })

  it('task_update requires a reason to block', async () => {
    const { ctx, root } = await harness()
    const turn = openTurn(root, { kind: 'user' })
    await execute(ctx, 'conductor_init', { objective: 'build' }, root.agent)
    const created = await execute(ctx, 'task_create', { tasks: [{ title: 'one', description: 'first' }] }, root.agent)
    const tasks = boardTasks(resultBoard(created))
    const result = await execute(ctx, 'task_update', { task_id: taskField(tasks[0] ?? {}, 'id'), action: 'blocked' }, root.agent)
    expect(result.isError).toBe(true)
    closeTurn(root, turn)
  })

  it('conductor_update edits, switches mode, pauses, resumes, and blocks', async () => {
    const { ctx, root } = await harness()
    const turn = openTurn(root, { kind: 'user' })
    const init = await execute(ctx, 'conductor_init', { objective: 'build', plan_outline: 'p1' }, root.agent)
    const board = resultBoard(init)
    const edited = await execute(ctx, 'conductor_update', { action: 'edit', plan_outline: 'p2' }, root.agent)
    expect(resultBoard(edited)).toMatchObject({ planOutline: 'p2' })
    const reobjectived = await execute(ctx, 'conductor_update', { action: 'edit', objective: 'rebuild' }, root.agent)
    expect(resultBoard(reobjectived)).toMatchObject({ objective: 'rebuild', planOutline: 'p2' })
    const switched = await execute(ctx, 'conductor_update', { action: 'set_mode', mode: 'parallel', max_parallel_workers: 4 }, root.agent)
    expect(resultBoard(switched)).toMatchObject({ mode: 'parallel', maxParallelWorkers: 4 })
    const paused = await execute(ctx, 'conductor_update', { action: 'pause' }, root.agent)
    expect(resultBoard(paused)).toMatchObject({ phase: 'paused' })
    const resumed = await execute(ctx, 'conductor_update', { action: 'resume' }, root.agent)
    expect(resultBoard(resumed)).toMatchObject({ phase: 'active' })
    const blocked = await execute(ctx, 'conductor_update', { action: 'block', reason: 'waiting' }, root.agent)
    expect(resultBoard(blocked)).toMatchObject({ phase: 'blocked' })
    const invalid = await execute(ctx, 'conductor_update', { action: 'block' }, root.agent)
    expect(invalid.isError).toBe(true)
    const stale = await execute(ctx, 'conductor_update', { action: 'pause', mode: 'serial' }, root.agent)
    expect(stale.isError).toBe(true)
    void board
    closeTurn(root, turn)
  })

  it('rejects stale extra arguments and missing boards', async () => {
    const { ctx, root } = await harness()
    const turn = openTurn(root, { kind: 'user' })
    const result = await execute(ctx, 'task_create', { tasks: [{ title: 'x', description: 'y' }] }, root.agent)
    expect(result.isError).toBe(true)
    closeTurn(root, turn)
  })

  it('task_schedule spawns workers for ready tasks', async () => {
    const { ctx, root, startContinuable } = await harness()
    const turn = openTurn(root, { kind: 'user' })
    await execute(ctx, 'conductor_init', { objective: 'build' }, root.agent)
    await execute(ctx, 'task_create', { tasks: [{ title: 'one', description: 'first' }] }, root.agent)
    const scheduled = await execute(ctx, 'task_schedule', {}, root.agent)
    expect(scheduled.isError).toBe(false)
    expect(startContinuable).toHaveBeenCalledTimes(1)
    closeTurn(root, turn)
  })

  it('conductor_message delivers to a live assigned worker', async () => {
    const { ctx, root } = await harness()
    const turn = openTurn(root, { kind: 'user' })
    await execute(ctx, 'conductor_init', { objective: 'build' }, root.agent)
    await execute(ctx, 'task_create', { tasks: [{ title: 'one', description: 'first' }] }, root.agent)
    await execute(ctx, 'task_schedule', {}, root.agent)
    const board = resultBoard(await execute(ctx, 'task_board', {}, root.agent))
    const tasks = boardTasks(board)
    const assignee = taskField(tasks[0] ?? {}, 'assignee')
    const workerSession = ctx.sessions.get(SessionId(assignee))
    if (workerSession === undefined) throw new Error('expected the worker session')
    const worker = liveWorker(workerSession)
    ctx.agents.register(worker.agent)
    const delivered = await execute(ctx, 'conductor_message', { worker_id: assignee, message: 'please continue' }, root.agent)
    expect(delivered.isError).toBe(false)
    expect(worker.followups).toEqual(['please continue'])
    closeTurn(root, turn)
  })

  it('conductor_handover creates a successor window', async () => {
    const { ctx, root, startContinuable } = await harness()
    const turn = openTurn(root, { kind: 'user' })
    await execute(ctx, 'conductor_init', { objective: 'build' }, root.agent)
    const handed = await execute(ctx, 'conductor_handover', { reason: 'compacted 4 times' }, root.agent)
    expect(handed.isError).toBe(false)
    expect(startContinuable).toHaveBeenCalledTimes(1)
    const spec = startContinuable.mock.calls[0]?.[0] as { label: string }
    expect(spec.label).toBe('conductor-handover')
    // The retired window loses its mutation authority.
    const blocked = await execute(ctx, 'task_create', { tasks: [{ title: 'x', description: 'y' }] }, root.agent)
    expect(blocked.isError).toBe(true)
    closeTurn(root, turn)
  })

  it('rejects mutations from a session that is not the conductor', async () => {
    const { ctx, root } = await harness()
    const other = stubAgent('not-conductor')
    ctx.agents.register(other.agent)
    const turn = openTurn(root, { kind: 'user' })
    await execute(ctx, 'conductor_init', { objective: 'build' }, root.agent)
    const turnOther = openTurn(other, { kind: 'user' })
    const result = await execute(ctx, 'task_create', { tasks: [{ title: 'x', description: 'y' }] }, other.agent)
    expect(result.isError).toBe(true)
    closeTurn(other, turnOther)
    closeTurn(root, turn)
  })

  it('presents call cards for every tool', async () => {
    const { ctx } = await harness()
    expect(ctx.tools.get('conductor_init')?.presentCall?.({ objective: 'build' })).toMatchObject({
      card: 'generic',
      title: 'Create conductor board',
    })
    expect(ctx.tools.get('task_board')?.presentCall?.({})).toMatchObject({ title: 'Read task board', kind: 'read' })
    expect(ctx.tools.get('task_create')?.presentCall?.({ tasks: [{ title: 'one', description: 'd' }] }))
      .toMatchObject({ title: 'Create tasks' })
    expect(ctx.tools.get('task_update')?.presentCall?.({ task_id: 'task-1', action: 'blocked', reason: 'x' }))
      .toMatchObject({ title: 'Blocked task' })
    expect(ctx.tools.get('conductor_update')?.presentCall?.({ action: 'block', reason: 'x' }))
      .toMatchObject({ title: 'Block board' })
    expect(ctx.tools.get('conductor_update')?.presentCall?.({ action: 'set_mode', mode: 'parallel' }))
      .toMatchObject({ title: 'Set mode board' })
    expect(ctx.tools.get('conductor_update')?.presentCall?.({ action: 'pause' }))
      .toMatchObject({ title: 'Pause board', rawInput: 'pause' })
    expect(ctx.tools.get('task_schedule')?.presentCall?.({})).toMatchObject({ title: 'Schedule ready tasks' })
    expect(ctx.tools.get('conductor_message')?.presentCall?.({ worker_id: 'w', message: 'hi' }))
      .toMatchObject({ title: 'Message worker' })
    expect(ctx.tools.get('conductor_handover')?.presentCall?.({ reason: 'compacted' }))
      .toMatchObject({ title: 'Hand over conductor role' })
  })

  it('reads a null board before init and renders reports afterwards', async () => {
    const { ctx, root } = await harness()
    const turn = openTurn(root, { kind: 'user' })
    const empty = await execute(ctx, 'task_board', {}, root.agent)
    expect(resultJson(empty)).toEqual({ board: null })
    await execute(ctx, 'conductor_init', { objective: 'build' }, root.agent)
    await execute(ctx, 'task_create', { tasks: [{ title: 'one', description: 'first' }] }, root.agent)
    await execute(ctx, 'task_schedule', {}, root.agent)
    const view = ctx.conductor.get(root.agent)
    const taskId = view?.tasks[0]?.id
    const assignee = view?.tasks[0]?.assignee
    if (taskId === undefined || assignee === undefined) throw new Error('expected an assigned task')
    const session = ctx.sessions.get(assignee)
    if (session === undefined) throw new Error('expected the worker session')
    const worker = liveWorker(session)
    ctx.agents.register(worker.agent)
    ctx.conductor.report(worker.agent, { taskId, status: 'done', message: 'built' })
    const board = resultBoard(await execute(ctx, 'task_board', {}, root.agent))
    const tasks = boardTasks(board)
    expect(tasks[0]).toMatchObject({ status: 'done', reports: [{ message: 'built' }] })
    closeTurn(root, turn)
  })

  it('treats a zero parallel cap filler as omitted and accepts an empty depends_on list', async () => {
    const { ctx, root } = await harness()
    const turn = openTurn(root, { kind: 'user' })
    const init = await execute(ctx, 'conductor_init', {
      objective: 'build',
      mode: 'parallel',
      max_parallel_workers: 0,
    }, root.agent)
    expect(resultBoard(init)).toMatchObject({ maxParallelWorkers: 3, mode: 'parallel' })
    const capped = await execute(ctx, 'conductor_init', {
      objective: 'build',
      max_parallel_workers: 5,
    }, root.agent)
    expect(capped.isError).toBe(true)
    const created = await execute(ctx, 'task_create', {
      tasks: [{ title: 'one', description: 'first', depends_on: [] }],
    }, root.agent)
    const tasks = resultBoard(created)['tasks']
    if (!Array.isArray(tasks)) throw new Error('expected tasks')
    expect(tasks[0]).toMatchObject({ dependsOn: [] })
    closeTurn(root, turn)
  })

  it('rejects invalid tool arguments', async () => {
    const { ctx, root } = await harness()
    const turn = openTurn(root, { kind: 'user' })
    await execute(ctx, 'conductor_init', { objective: 'build' }, root.agent)
    const badTaskId = await execute(ctx, 'task_update', { task_id: '  ', action: 'done' }, root.agent)
    expect(badTaskId.isError).toBe(true)
    const editWithReason = await execute(ctx, 'conductor_update', { action: 'edit', plan_outline: 'p', reason: 'x' }, root.agent)
    expect(editWithReason.isError).toBe(true)
    const editWithoutFields = await execute(ctx, 'conductor_update', { action: 'edit' }, root.agent)
    expect(editWithoutFields.isError).toBe(true)
    const setModeWithReason = await execute(ctx, 'conductor_update', { action: 'set_mode', mode: 'parallel', reason: 'x' }, root.agent)
    expect(setModeWithReason.isError).toBe(true)
    const setModeWithoutArgs = await execute(ctx, 'conductor_update', { action: 'set_mode' }, root.agent)
    expect(setModeWithoutArgs.isError).toBe(true)
    const setModeCapOnly = await execute(ctx, 'conductor_update', { action: 'set_mode', max_parallel_workers: 5 }, root.agent)
    expect(resultBoard(setModeCapOnly)).toMatchObject({ mode: 'parallel', maxParallelWorkers: 5 })
    const blockWithExtra = await execute(ctx, 'conductor_update', { action: 'block', reason: 'x', mode: 'parallel' }, root.agent)
    expect(blockWithExtra.isError).toBe(true)
    const blockWithoutReason = await execute(ctx, 'conductor_update', { action: 'block' }, root.agent)
    expect(blockWithoutReason.isError).toBe(true)
    const completed = await execute(ctx, 'conductor_update', { action: 'complete' }, root.agent)
    expect(resultBoard(completed)).toMatchObject({ phase: 'complete' })
    const pauseWithExtra = await execute(ctx, 'conductor_update', { action: 'pause', reason: 'x' }, root.agent)
    expect(pauseWithExtra.isError).toBe(true)
    const started = await execute(ctx, 'task_update', { task_id: 'missing', action: 'start' }, root.agent)
    expect(started.isError).toBe(true)
    closeTurn(root, turn)
  })

  it('rejects calls without an agent and from a closed turn', async () => {
    const { ctx, root } = await harness()
    const noAgent = await execute(ctx, 'task_board', {})
    expect(noAgent.isError).toBe(true)
    const closed = stubAgent('closed-turn')
    ctx.agents.register(closed.agent)
    const turn = openTurn(closed, { kind: 'user' })
    closeTurn(closed, turn)
    const closedResult = await execute(ctx, 'task_board', {}, closed.agent)
    expect(closedResult.isError).toBe(true)
    const unknown = stubAgent('not-registered')
    const unknownResult = await execute(ctx, 'task_board', {}, unknown.agent)
    expect(unknownResult.isError).toBe(true)
    void root
  })

  it('rejects mutations without a board and empty task batches', async () => {
    const { ctx, root } = await harness()
    const turn = openTurn(root, { kind: 'user' })
    const updateWithoutBoard = await execute(ctx, 'task_update', { task_id: 'task-1', action: 'done' }, root.agent)
    expect(updateWithoutBoard.isError).toBe(true)
    const conductorUpdateWithoutBoard = await execute(ctx, 'conductor_update', { action: 'pause' }, root.agent)
    expect(conductorUpdateWithoutBoard.isError).toBe(true)
    const emptyBatch = await execute(ctx, 'task_create', { tasks: [] }, root.agent)
    expect(emptyBatch.isError).toBe(false)
    expect(resultJson(emptyBatch)).toEqual({ board: null })
    closeTurn(root, turn)
  })

  it('edits the objective, completes tasks, and renders an empty schedule', async () => {
    const { ctx, root } = await harness()
    const turn = openTurn(root, { kind: 'user' })
    await execute(ctx, 'conductor_init', { objective: 'a', plan_outline: 'p1' }, root.agent)
    const edited = await execute(ctx, 'conductor_update', { action: 'edit', objective: 'b', plan_outline: 'p2' }, root.agent)
    expect(resultBoard(edited)).toMatchObject({ objective: 'b', planOutline: 'p2' })
    const created = await execute(ctx, 'task_create', { tasks: [{ title: 'one', description: 'first' }] }, root.agent)
    const tasks = boardTasks(resultBoard(created))
    const idOne = taskField(tasks[0] ?? {}, 'id')
    const started = await execute(ctx, 'task_update', { task_id: idOne, action: 'start' }, root.agent)
    expect(boardTasks(resultBoard(started))).toMatchObject([{ status: 'in-progress' }])
    const reassigned = await execute(ctx, 'task_update', { task_id: idOne, action: 'reassign' }, root.agent)
    expect(boardTasks(resultBoard(reassigned))).toMatchObject([{ status: 'todo' }])
    const done = await execute(ctx, 'task_update', { task_id: idOne, action: 'done' }, root.agent)
    expect(boardTasks(resultBoard(done))).toMatchObject([{ status: 'done' }])
    const scheduled = await execute(ctx, 'task_schedule', {}, root.agent)
    expect(scheduled.isError).toBe(false)
    expect(ctx.tools.get('conductor_update')?.presentCall?.({ action: 'edit', plan_outline: 'p' }))
      .toMatchObject({ title: 'Edit board' })
    expect(ctx.tools.get('conductor_update')?.presentCall?.({ action: 'edit', objective: 'b' }))
      .toMatchObject({ rawInput: 'b' })
    closeTurn(root, turn)
  })

  it('rejects an invalid worker-handover configuration on direct apply', () => {
    const ctx = new Context()
    contexts.push(ctx)
    expect(() => {
      toolConductor.apply(ctx, { workerHandoverAfterCompactions: 0 })
    }).toThrow('workerHandoverAfterCompactions must be a positive safe integer')
  })

  it('applies the default worker threshold on a direct apply without a field', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    // Direct apply bypasses Cordis config normalization, exercising the
    // in-function default exactly like a config-less Loader row.
    expect(() => { toolConductor.apply(ctx, {}) }).not.toThrow()
  })
})
