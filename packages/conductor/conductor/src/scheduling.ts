/**
 * Pure scheduling over a conductor board: the ready set from dependencies,
 * the serial/parallel spawn plan, and the board-level terminal conditions.
 * @module @deepseek-ai/dsh-conductor
 */

import type { ConductorSnapshot, TaskSnapshot } from './types.ts'

/** The tasks the next scheduling pass must act on. */
export interface SchedulingPlan {
  /** Tasks eligible for a worker right now, in creation order. */
  readonly ready: readonly TaskSnapshot[]
  /** Tasks newly blocked because a dependency is blocked. */
  readonly dependencyBlocked: readonly TaskSnapshot[]
  /** Tasks currently assigned to a worker. */
  readonly inProgress: readonly TaskSnapshot[]
  /** Tasks that reached the done status. */
  readonly done: readonly TaskSnapshot[]
  /** Tasks blocked for any reason. */
  readonly blocked: readonly TaskSnapshot[]
}

/**
 * Classify every task of a board into the scheduling plan.
 * @param board - the board to plan against.
 * @returns the classified task groups; `ready` never contains a task whose
 *   dependencies are not all done.
 */
export function planScheduling(board: ConductorSnapshot): SchedulingPlan {
  const byId = new Map(board.tasks.map(task => [task.id, task]))
  const done = board.tasks.filter(task => task.status === 'done')
  const doneIds = new Set(done.map(task => task.id))
  const blocked = board.tasks.filter(task => task.status === 'blocked')
  const inProgress = board.tasks.filter(task => task.status === 'in-progress')
  const ready: TaskSnapshot[] = []
  const dependencyBlocked: TaskSnapshot[] = []
  for (const task of board.tasks) {
    if (task.status !== 'todo') continue
    const deps = task.dependsOn.map(dep => byId.get(dep))
    const anyBlockedDep = deps.some(dep => dep?.status === 'blocked')
    if (anyBlockedDep) {
      dependencyBlocked.push(task)
      continue
    }
    if (deps.every(dep => dep !== undefined && doneIds.has(dep.id))) {
      ready.push(task)
    }
  }
  return { ready, dependencyBlocked, inProgress, done, blocked }
}

/**
 * Compute which ready tasks get a worker under one scheduling mode.
 * @param board - the board to plan against.
 * @param parallelCap - the resolved parallel cap (the board's own value).
 * @returns the tasks to spawn: the first ready task in serial mode; ready
 *   tasks up to the remaining parallel capacity otherwise.
 */
export function planWorkerStarts(
  board: ConductorSnapshot,
  plan: SchedulingPlan,
  parallelCap: number,
): readonly TaskSnapshot[] {
  if (plan.ready.length === 0) return []
  if (board.mode === 'serial') {
    if (plan.inProgress.length > 0) return []
    /* v8 ignore start -- a non-empty ready array always yields a first element */
    const first = plan.ready[0]
    if (first === undefined) return []
    /* v8 ignore stop */
    return [first]
  }
  const capacity = Math.max(0, parallelCap - plan.inProgress.length)
  return plan.ready.slice(0, capacity)
}

/** Whether every task reached done (a non-empty board completing). */
export function allTasksDone(board: ConductorSnapshot): boolean {
  return board.tasks.length > 0 && board.tasks.every(task => task.status === 'done')
}
