import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ConductorId, TaskId } from '@deepseek-ai/dsh-conductor'
import type { ConductorSnapshot } from '@deepseek-ai/dsh-conductor'
import type { ConductorSnapshotChangeMeta } from '@deepseek-ai/dsh-conductor'
import * as ConductorInvariantCompanion from '@deepseek-ai/dsh-conductor/invariant'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'

/** One task snapshot used across the fixture changes. */
const taskOne = {
  id: TaskId('task-one'),
  title: 'one',
  description: 'first',
  status: 'todo',
  dependsOn: [],
  reports: [],
} as const

const taskTwo = {
  id: TaskId('task-two'),
  title: 'two',
  description: 'second',
  status: 'todo',
  dependsOn: [TaskId('task-one')],
  reports: [],
} as const

/** Build one board snapshot from a base and a deep patch. */
function board(
  revision: number,
  patch: (base: Record<string, unknown>) => Record<string, unknown>,
): ConductorSnapshot {
  const base: Record<string, unknown> = {
    id: ConductorId('conductor-invariant'),
    revision,
    objective: 'check the stream',
    planOutline: 'plan',
    mode: 'serial',
    maxParallelWorkers: 3,
    phase: 'active',
    conductorSessionId: SessionId('conductor-session'),
    handoverCount: 0,
    tasks: [],
  }
  return patch(base) as unknown as ConductorSnapshot
}

/** Build one change carrying the patched board. */
function change(
  operation: ConductorSnapshotChangeMeta['operation'],
  revision: number,
  patch: (base: Record<string, unknown>) => Record<string, unknown> = base => base,
  overrides: Partial<ConductorSnapshotChangeMeta> = {},
): ConductorSnapshotChangeMeta {
  return {
    kind: 'conductor/change',
    version: 1,
    operation,
    board: board(revision, patch),
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

/** Clone a task fixture into a mutable record. */
function task(task: Record<string, unknown>, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...task, ...patch }
}

interface SessionFixture {
  ctx: Context
  appendInvalid(changeMeta: unknown): unknown
}

/** Mount the invariant over a session that already holds a valid init. */
async function sessionWith(seedChanges: ConductorSnapshotChangeMeta[]): Promise<SessionFixture> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(ConductorInvariantCompanion)
  const session = ctx.sessions.create(SessionId(`conductor-invariant-${Math.random()}`))
  for (const seed of seedChanges) session.append('conductor/change', seed)
  return {
    ctx,
    appendInvalid(meta: unknown): unknown {
      let thrown: unknown
      try {
        session.append('conductor/change', meta as never)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(InvariantError)
      return thrown
    },
  }
}

/** Run one invalid scenario and assert the invariant rejects it. */
async function rejects(meta: ConductorSnapshotChangeMeta, seeds: ConductorSnapshotChangeMeta[] = [change('init', 1)]): Promise<void> {
  const fixture = await sessionWith(seeds)
  fixture.appendInvalid(meta)
}

describe('conductor stream invariants: decode rejections', () => {
  it('rejects wrong versions, operations, and envelope shapes', async () => {
    await rejects({ ...change('init', 1), version: 99 } as never)
    await rejects({ ...change('init', 1), operation: 'explode' } as never)
    await rejects({ ...change('init', 1), extra: true } as never)
    await rejects({ ...change('init', 1), kind: 'other/change' } as never)
  })

  it('rejects malformed board snapshots', async () => {
    await rejects(change('init', 1, base => ({ ...base, revision: 0 })))
    await rejects(change('init', 1, base => ({ ...base, revision: 1.5 })))
    await rejects(change('init', 1, base => ({ ...base, objective: '  spaced  ' })))
    await rejects(change('init', 1, base => ({ ...base, objective: '' })))
    await rejects(change('init', 1, base => ({ ...base, planOutline: ' spaced ' })))
    await rejects(change('init', 1, base => ({ ...base, mode: 'burst' })))
    await rejects(change('init', 1, base => ({ ...base, maxParallelWorkers: 0 })))
    await rejects(change('init', 1, base => ({ ...base, phase: 'exploded' })))
    await rejects(change('init', 1, base => ({ ...base, conductorSessionId: '' })))
    await rejects(change('init', 1, base => ({ ...base, handoverCount: -1 })))
    await rejects(change('init', 1, base => ({ ...base, id: '' })))
    await rejects(change('init', 1, base => ({ ...base, extra: 1 })))
    await rejects(change('init', 1, base => ({ ...base, tasks: 'not-an-array' })))
    await rejects(change('init', 1, base => ({ ...base, blockedReason: { code: 'x', message: 'y' } })))
    await rejects(change('block', 2, base => ({
      ...base,
      phase: 'blocked',
      blockedReason: { code: 'UPPER', message: 'why' },
    })))
    await rejects(change('block', 2, base => ({
      ...base,
      phase: 'blocked',
      blockedReason: { code: 'ok', message: '  spaced  ' },
    })))
    await rejects(change('block', 2, base => ({
      ...base,
      phase: 'blocked',
      blockedReason: { code: 'ok', extra: 1 },
    })))
  })

  it('rejects malformed tasks and reports', async () => {
    await rejects(change('task-create', 2, base => ({ ...base, tasks: [task(taskOne), task(taskOne)] })))
    await rejects(change('task-create', 2, base => ({ ...base, tasks: [task(taskOne, { status: 'spinning' })] })))
    await rejects(change('task-create', 2, base => ({ ...base, tasks: [task(taskOne, { title: '' })] })))
    await rejects(change('task-create', 2, base => ({ ...base, tasks: [task(taskOne, { title: ' spaced ' })] })))
    await rejects(change('task-create', 2, base => ({ ...base, tasks: [task(taskOne, { description: '' })] })))
    await rejects(change('task-create', 2, base => ({ ...base, tasks: [task(taskOne, { id: '' })] })))
    await rejects(change('task-create', 2, base => ({ ...base, tasks: [task(taskOne, { extra: 1 })] })))
    await rejects(change('task-create', 2, base => ({ ...base, tasks: [task(taskOne, { assignee: '' })] })))
    await rejects(change('task-create', 2, base => ({ ...base, tasks: [task(taskOne, { dependsOn: [TaskId('ghost')] })] })))
    await rejects(change('task-create', 2, base => ({ ...base, tasks: [task(taskOne, { dependsOn: [TaskId('task-one'), TaskId('task-one')] })] })))
    await rejects(change('task-create', 2, base => ({ ...base, tasks: [task(taskOne, { dependsOn: [''] })] })))
    await rejects(change('task-create', 2, base => ({ ...base, tasks: [task(taskOne, { reports: 'nope' })] })))
    await rejects(change('task-create', 2, base => ({
      ...base,
      tasks: [task(taskOne, { reports: [{ status: 'finished', message: 'x', at: 1, workerSessionId: 'w', workerCompactions: 0 }] })],
    })))
    await rejects(change('task-create', 2, base => ({
      ...base,
      tasks: [task(taskOne, { reports: [{ status: 'done', message: '', at: 1, workerSessionId: 'w', workerCompactions: 0 }] })],
    })))
    await rejects(change('task-create', 2, base => ({
      ...base,
      tasks: [task(taskOne, { reports: [{ status: 'done', message: 'x', at: -1, workerSessionId: 'w', workerCompactions: 0 }] })],
    })))
    await rejects(change('task-create', 2, base => ({
      ...base,
      tasks: [task(taskOne, { status: 'blocked' })],
    })))
    await rejects(change('task-create', 2, base => ({
      ...base,
      tasks: [task(taskOne, { status: 'blocked', blockedReason: { code: 'x', message: 'why' } })],
    }), { operation: 'task-create' }))
  })

  it('rejects malformed clears', async () => {
    await rejects({
      kind: 'conductor/change',
      version: 1,
      operation: 'clear',
      cleared: { id: ConductorId('conductor-invariant'), revision: 2, extra: 1 },
      clearedAt: 2,
    } as never)
    await rejects({
      kind: 'conductor/change',
      version: 1,
      operation: 'clear',
      cleared: { id: ConductorId('conductor-invariant'), revision: 2 },
      clearedAt: 2,
      extra: 1,
    } as never)
    await rejects({
      kind: 'conductor/change',
      version: 1,
      operation: 'clear',
      cleared: { id: '', revision: 2 },
      clearedAt: 2,
    } as never)
    await rejects({
      kind: 'conductor/change',
      version: 1,
      operation: 'clear',
      cleared: { id: ConductorId('conductor-invariant'), revision: 0 },
      clearedAt: 2,
    } as never)
  })
})

describe('conductor stream invariants: transition rejections', () => {
  it('rejects init and clear misuse', async () => {
    await rejects(change('init', 2))
    await rejects(change('init', 1, base => ({ ...base, tasks: [task(taskOne)] })))
    await rejects(change('init', 1, base => ({ ...base, handoverCount: 1 })))
    await rejects({
      kind: 'conductor/change',
      version: 1,
      operation: 'clear',
      cleared: { id: ConductorId('conductor-invariant'), revision: 9 },
      clearedAt: 2,
    } as never)
  })

  it('rejects edits and mode switches that change the wrong fields', async () => {
    await rejects(change('edit', 2))
    await rejects(change('edit', 2, base => ({ ...base, objective: 'changed', tasks: [task(taskOne)] })))
    await rejects(change('edit', 2, base => ({ ...base, objective: 'changed', phase: 'paused' })))
    await rejects(change('edit', 2, base => ({ ...base, objective: 'changed', conductorSessionId: SessionId('other') })))
    await rejects(change('set-mode', 2))
    await rejects(change('set-mode', 2, base => ({ ...base, mode: 'parallel', tasks: [task(taskOne)] })))
    await rejects(change('set-mode', 2, base => ({ ...base, mode: 'parallel', objective: 'changed' })))
  })

  it('rejects invalid phase transitions', async () => {
    const paused = change('pause', 2, base => ({ ...base, phase: 'paused' }))
    await rejects(change('pause', 3, base => ({ ...base, phase: 'paused' })), [change('init', 1), paused])
    await rejects(change('resume', 2, base => ({ ...base, phase: 'active' }), {
      createdAt: 1,
      updatedAt: 1,
    }), [change('init', 1), change('complete', 2, base => ({ ...base, phase: 'complete' }))])
    await rejects(change('complete', 2, base => ({ ...base, phase: 'complete' })), [
      change('init', 1),
      change('complete', 2, base => ({ ...base, phase: 'complete' })),
    ])
    await rejects(change('complete', 3, base => ({ ...base, phase: 'paused' })), [
      change('init', 1),
      paused,
    ])
    await rejects(change('block', 3, base => ({
      ...base,
      phase: 'blocked',
      blockedReason: { code: 'x', message: 'why' },
    })), [change('init', 1), paused])
    await rejects(change('block', 2, base => ({ ...base, phase: 'blocked' })))
    await rejects(change('resume', 2, base => ({
      ...base,
      phase: 'active',
      blockedReason: { code: 'x', message: 'why' },
    }), { operation: 'resume' }), [
      change('init', 1),
      change('block', 2, base => ({ ...base, phase: 'blocked', blockedReason: { code: 'x', message: 'why' } })),
    ])
  })

  it('rejects invalid task mutations', async () => {
    const seeded = [
      change('init', 1),
      change('task-create', 2, base => ({ ...base, tasks: [task(taskOne)] })),
    ]
    await rejects(change('task-create', 3, base => ({
      ...base,
      tasks: [task(taskOne), task(taskTwo), task({ ...taskTwo, id: TaskId('task-three') })],
    })), seeded)
    await rejects(change('task-create', 3, base => ({ ...base, tasks: [task(taskOne, { title: 'edited' })] })), seeded)
    await rejects(change('task-create', 3, base => ({
      ...base,
      tasks: [task(taskOne, { status: 'in-progress', assignee: SessionId('w') })],
    })), seeded)
    await rejects(change('task-edit', 3, base => ({ ...base, tasks: [task(taskOne, { status: 'done' })] })), seeded)
    await rejects(change('task-edit', 3, base => ({ ...base, tasks: [task(taskOne, { reports: [{
      status: 'done',
      message: 'x',
      at: 1,
      workerSessionId: SessionId('w'),
      workerCompactions: 0,
    }] })] })), seeded)
    await rejects(change('task-status', 4, base => ({
      ...base,
      tasks: [task(taskOne, {
        status: 'blocked',
        blockedReason: { code: 'x', message: 'still stuck' },
      })],
    })), [
      ...seeded,
      change('task-status', 3, base => ({
        ...base,
        tasks: [task(taskOne, { status: 'blocked', blockedReason: { code: 'x', message: 'stuck' } })],
      })),
    ])
    await rejects(change('task-status', 3, base => ({ ...base, tasks: [task(taskOne, { status: 'blocked' })] })), seeded)
    await rejects(change('task-status', 3, base => ({
      ...base,
      tasks: [task(taskOne, { status: 'done', assignee: SessionId('w') })],
    })), seeded)
    await rejects(change('task-assign', 3, base => ({
      ...base,
      tasks: [task(taskOne, { status: 'in-progress' })],
    })), seeded)
    await rejects(change('task-assign', 3, base => ({
      ...base,
      tasks: [task(taskOne, { status: 'todo', assignee: SessionId('w') })],
    })), seeded)
    await rejects(change('task-assign', 3, base => ({
      ...base,
      tasks: [task(taskOne, { status: 'done', assignee: SessionId('w') })],
    })), seeded)
    await rejects(change('task-report', 3, base => ({ ...base, tasks: [task(taskOne)] })), seeded)
    await rejects(change('task-report', 3, base => ({
      ...base,
      tasks: [task(taskOne, { reports: [{ status: 'done', message: 'x', at: 1, workerSessionId: 'w', workerCompactions: 0 }] })],
    })), seeded)
    await rejects(change('task-report', 3, base => ({
      ...base,
      tasks: [task(taskOne, {
        status: 'done',
        reports: [{ status: 'progress', message: 'x', at: 1, workerSessionId: 'w', workerCompactions: 0 }],
      })],
    })), seeded)
    await rejects(change('task-report', 3, base => ({
      ...base,
      tasks: [task(taskOne, {
        reports: [
          { status: 'done', message: 'older', at: 1, workerSessionId: 'w', workerCompactions: 0 },
          { status: 'done', message: 'x', at: 2, workerSessionId: 'w', workerCompactions: 0 },
        ],
      })],
    })), seeded)
    await rejects(change('task-report', 3, base => ({
      ...base,
      tasks: [task(taskOne, {
        assignee: SessionId('w'),
        reports: [{ status: 'progress', message: 'x', at: 1, workerSessionId: 'w', workerCompactions: 0 }],
      })],
    })), seeded)
  })

  it('rejects invalid handovers and timestamps', async () => {
    const seeded = [
      change('init', 1),
      change('task-create', 2, base => ({ ...base, tasks: [task(taskOne)] })),
    ]
    await rejects(change('handover', 3, base => ({
      ...base,
      conductorSessionId: SessionId('conductor-session'),
      handoverCount: 1,
    })), seeded)
    await rejects(change('handover', 3, base => ({
      ...base,
      conductorSessionId: SessionId('successor'),
      handoverCount: 5,
    })), seeded)
    await rejects(change('handover', 3, base => ({
      ...base,
      conductorSessionId: SessionId('successor'),
      handoverCount: 1,
      objective: 'changed',
    })), seeded)
    await rejects(change('handover', 3, base => ({
      ...base,
      conductorSessionId: SessionId('successor'),
      handoverCount: 1,
      tasks: [task(taskOne), task(taskTwo)],
    })), seeded)
    await rejects(change('edit', 2, base => ({ ...base, objective: 'changed' }), { updatedAt: 0 }))
    await rejects(change('edit', 2, base => ({ ...base, objective: 'changed' }), { createdAt: 5, updatedAt: 1 }))
    await rejects(change('edit', 9, base => ({ ...base, objective: 'changed' })))
    // updatedAt regressing below the previous change's timestamp.
    await rejects(change('edit', 2, base => ({ ...base, objective: 'changed' }), {
      createdAt: 1,
      updatedAt: 1,
    }), [change('init', 1, base => base, { createdAt: 1, updatedAt: 5 })])
  })

  it('rejects set-mode phase changes and resume into a non-active phase', async () => {
    await rejects(change('set-mode', 2, base => ({
      ...base,
      mode: 'parallel',
      phase: 'paused',
    })))
    await rejects(change('resume', 2, base => ({ ...base, phase: 'paused' })))
  })

  it('rejects handover installs into an empty stream with no handover count', async () => {
    await rejects(change('handover', 3, base => ({
      ...base,
      conductorSessionId: SessionId('successor'),
      handoverCount: 0,
    })), [])
  })

  it('rejects dependency cycles and non-record tasks and reports', async () => {
    await rejects(change('task-create', 2, base => ({
      ...base,
      tasks: [
        task(taskOne, { dependsOn: [TaskId('task-two')] }),
        task(taskTwo),
      ],
    })))
    await rejects(change('task-create', 2, base => ({ ...base, tasks: [42] })))
    await rejects(change('task-create', 2, base => ({
      ...base,
      tasks: [task(taskOne, { reports: [42] })],
    })))
    await rejects(change('task-create', 2, base => ({
      ...base,
      tasks: [task(taskOne, { reports: [{ status: 'done', message: 'x' }] })],
    })))
    await rejects(change('init', 1, () => 'not-a-record' as never))
  })

  it('rejects task mutations that touch the wrong tasks or fields', async () => {
    const seeded = [
      change('init', 1),
      change('task-create', 2, base => ({ ...base, tasks: [task(taskOne)] })),
    ]
    await rejects(change('task-edit', 3, base => ({
      ...base,
      tasks: [task(taskOne), task(taskTwo)],
    })), seeded)
    await rejects(change('task-edit', 3, base => ({
      ...base,
      tasks: [task(taskOne, { id: TaskId('task-other') })],
    })), seeded)
    await rejects(change('task-status', 4, base => ({
      ...base,
      tasks: [task(taskOne, { status: 'done' }), task(taskTwo, { status: 'done' })],
    })), [
      ...seeded,
      change('task-create', 3, base => ({ ...base, tasks: [task(taskOne), task(taskTwo)] })),
    ])
    await rejects(change('task-assign', 3, base => ({
      ...base,
      tasks: [task(taskOne, { status: 'in-progress', assignee: SessionId('w'), title: 'edited' })],
    })), seeded)
    await rejects(change('task-create', 3, base => ({
      ...base,
      tasks: [
        task({ ...taskOne, id: TaskId('task-x') }),
        task({ ...taskTwo, id: TaskId('task-y'), dependsOn: [] }),
      ],
    })), seeded)
    await rejects(change('task-create', 3, base => ({
      ...base,
      tasks: [task(taskOne, { title: 'edited' }), task(taskTwo)],
    })), seeded)
  })

  it('accepts a blocked-to-todo status transition', async () => {
    const fixture = await sessionWith([
      change('init', 1),
      change('task-create', 2, base => ({ ...base, tasks: [task(taskOne)] })),
      change('task-status', 3, base => ({
        ...base,
        tasks: [task(taskOne, { status: 'blocked', blockedReason: { code: 'x', message: 'why' } })],
      })),
      change('task-status', 4, base => ({
        ...base,
        tasks: [task(taskOne, { status: 'todo' })],
      })),
    ])
    void fixture
  })

  it('rejects report history corruption and done-status exit', async () => {
    const reportOne = { status: 'progress', message: 'r1', at: 1, workerSessionId: 'w', workerCompactions: 0 }
    const reportTwo = { status: 'progress', message: 'r2', at: 2, workerSessionId: 'w', workerCompactions: 0 }
    const reportThree = { status: 'progress', message: 'r3', at: 3, workerSessionId: 'w', workerCompactions: 0 }
    const withReports = [
      change('init', 1),
      change('task-create', 2, base => ({ ...base, tasks: [task(taskOne)] })),
      change('task-report', 3, base => ({
        ...base,
        tasks: [task(taskOne, { status: 'in-progress', reports: [reportOne] })],
      })),
      change('task-report', 4, base => ({
        ...base,
        tasks: [task(taskOne, { status: 'in-progress', reports: [reportOne, reportTwo] })],
      })),
    ]
    await rejects(change('task-report', 5, base => ({
      ...base,
      tasks: [task(taskOne, { status: 'in-progress', reports: [reportOne, reportThree] })],
    })), withReports)
    await rejects(change('task-report', 5, base => ({
      ...base,
      tasks: [task(taskOne, { status: 'in-progress', reports: [reportTwo, reportTwo] })],
    })), withReports)
    await rejects(change('task-status', 4, base => ({
      ...base,
      tasks: [task(taskOne, { status: 'todo' })],
    })), [
      change('init', 1),
      change('task-create', 2, base => ({ ...base, tasks: [task(taskOne)] })),
      change('task-status', 3, base => ({ ...base, tasks: [task(taskOne, { status: 'done' })] })),
    ])
  })

  it('accepts canonical positive transitions', async () => {
    const fixture = await sessionWith([
      change('init', 1),
      change('pause', 2, base => ({ ...base, phase: 'paused' })),
      change('resume', 3, base => ({ ...base, phase: 'active' })),
      change('task-create', 4, base => ({ ...base, tasks: [task(taskOne)] })),
      change('task-assign', 5, base => ({
        ...base,
        tasks: [task(taskOne, { status: 'in-progress', assignee: SessionId('w') })],
      })),
      change('task-report', 6, base => ({
        ...base,
        tasks: [task(taskOne, {
          status: 'in-progress',
          assignee: SessionId('w'),
          reports: [{ status: 'progress', message: 'r1', at: 1, workerSessionId: 'w', workerCompactions: 0 }],
        })],
      })),
      change('task-status', 7, base => ({
        ...base,
        tasks: [task(taskOne, {
          status: 'done',
          assignee: SessionId('w'),
          reports: [{ status: 'progress', message: 'r1', at: 1, workerSessionId: 'w', workerCompactions: 0 }],
        })],
      })),
      change('complete', 8, base => ({
        ...base,
        tasks: [task(taskOne, {
          status: 'done',
          assignee: SessionId('w'),
          reports: [{ status: 'progress', message: 'r1', at: 1, workerSessionId: 'w', workerCompactions: 0 }],
        })],
        phase: 'complete',
      })),
    ])
    void fixture
  })

  it('rejects clear misuse and operations without a current board', async () => {
    await rejects({
      kind: 'conductor/change',
      version: 1,
      operation: 'clear',
      cleared: { id: ConductorId('conductor-invariant'), revision: 9 },
      clearedAt: 2,
    } as never, [])
    await rejects({
      kind: 'conductor/change',
      version: 1,
      operation: 'clear',
      cleared: { id: ConductorId('conductor-invariant'), revision: 2 },
      clearedAt: 0,
    } as never)
    await rejects(change('task-create', 1, base => ({ ...base, tasks: [task(taskOne)] })), [])
  })
})
