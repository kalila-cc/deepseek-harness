import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ConductorId, TaskId } from '@deepseek-ai/dsh-conductor'
import { applyConductorProjection, foldConductor } from '@deepseek-ai/dsh-conductor'
import type { ConductorProjection } from '@deepseek-ai/dsh-conductor'
import type { ConductorSnapshotChangeMeta } from '@deepseek-ai/dsh-conductor'

function change(board: ConductorProjection['board'], operation: ConductorSnapshotChangeMeta['operation'] = 'init'): ConductorSnapshotChangeMeta {
  return {
    kind: 'conductor/change',
    version: 1,
    operation,
    board,
    createdAt: 1,
    updatedAt: 1,
  }
}

function board(revision: number): ConductorProjection['board'] {
  return {
    id: ConductorId('conductor-projection'),
    revision,
    objective: 'build',
    planOutline: 'plan',
    mode: 'serial',
    maxParallelWorkers: 3,
    phase: 'active',
    conductorSessionId: SessionId('session-1'),
    handoverCount: 0,
    tasks: [],
  }
}

describe('conductor projection fold', () => {
  it('stays null before the first init and after a clear', () => {
    const unrelated = { type: 'turn/start' as const, seq: 0, time: 1, data: { turn: 1 } }
    expect(applyConductorProjection(null, unrelated)).toBeNull()
    const clear = {
      kind: 'conductor/change',
      version: 1,
      operation: 'clear' as const,
      cleared: { id: ConductorId('conductor-projection'), revision: 2 },
      clearedAt: 2,
    }
    const projected = applyConductorProjection({ board: board(1), createdAt: 1, updatedAt: 1 }, {
      type: 'conductor/change',
      seq: 1,
      time: 2,
      data: clear,
    } as never)
    expect(projected).toBeNull()
  })

  it('reflects the latest whole board value and tolerates malformed changes', () => {
    const event = { type: 'conductor/change' as const, seq: 0, time: 1, data: change(board(1)) }
    const projected = applyConductorProjection(null, event)
    expect(projected).toMatchObject({ board: { revision: 1, objective: 'build' }, createdAt: 1, updatedAt: 1 })
    const malformed = applyConductorProjection(projected, {
      type: 'conductor/change',
      seq: 1,
      time: 2,
      data: { kind: 'conductor/change', version: 99 } as never,
    })
    expect(malformed).toBe(projected)
    const nonBoard = applyConductorProjection(projected, {
      type: 'user/message' as const,
      seq: 1,
      time: 2,
      data: {} as never,
      surfaceOp: 'append',
    })
    expect(nonBoard).toBe(projected)
  })

  it('carries tasks with their report entries', () => {
    const withTask: ConductorProjection['board'] = {
      ...board(2),
      tasks: [{
        id: TaskId('task-1'),
        title: 'one',
        description: 'first',
        status: 'done',
        dependsOn: [],
        reports: [{
          status: 'done',
          message: 'built',
          at: 3,
          workerSessionId: SessionId('worker-1'),
          workerCompactions: 0,
        }],
      }],
    }
    const event = { type: 'conductor/change' as const, seq: 0, time: 1, data: change(withTask, 'task-create') }
    const projected = applyConductorProjection(null, event)
    expect(projected?.board.tasks[0]).toMatchObject({ id: TaskId('task-1'), status: 'done' })
  })

  it('keeps the prior projection when a conductor/change payload has a foreign kind', () => {
    const projected = { board: board(1), createdAt: 1, updatedAt: 1 }
    const foreign = applyConductorProjection(projected, {
      type: 'conductor/change',
      seq: 1,
      time: 2,
      data: { kind: 'other/change' } as never,
    })
    expect(foreign).toBe(projected)
  })

  it('folds a whole log into a detached projection', () => {
    const withTask: ConductorProjection['board'] = {
      ...board(2),
      tasks: [{
        id: TaskId('task-1'),
        title: 'one',
        description: 'first',
        status: 'todo',
        dependsOn: [],
        reports: [],
      }],
    }
    const events = [
      { type: 'conductor/change' as const, seq: 0, time: 1, data: change(board(1)) },
      { type: 'conductor/change' as const, seq: 1, time: 2, data: change(withTask, 'task-create') },
    ]
    const folded = foldConductor(events)
    expect(folded).toMatchObject({ board: { revision: 2, tasks: [{ id: TaskId('task-1') }] }, lastRef: { revision: 2 } })
    expect(foldConductor([])).toEqual({})
  })
})
