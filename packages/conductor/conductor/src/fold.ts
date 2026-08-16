/** Pure replay fold and strict decoder for durable conductor changes. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { CONDUCTOR_CHANGE_VERSION, ConductorId, TaskId } from './runtime.ts'
import type {
  ConductorBlockReason,
  ConductorMode,
  ConductorPhase,
  ConductorRef,
  ConductorSnapshot,
  TaskBlockReason,
  TaskReportEntry,
  TaskReportStatus,
  TaskSnapshot,
  TaskStatus,
} from './types.ts'
import type {
  ConductorChangeMeta,
  ConductorClearChangeMeta,
  ConductorOperation,
  ConductorSnapshotChangeMeta,
  FoldedConductor,
} from './domain.ts'

const SNAPSHOT_OPERATIONS: ReadonlySet<Exclude<ConductorOperation, 'clear'>> = new Set([
  'init',
  'edit',
  'set-mode',
  'pause',
  'resume',
  'complete',
  'block',
  'task-create',
  'task-edit',
  'task-status',
  'task-assign',
  'task-report',
  'handover',
])
const PHASES: ReadonlySet<ConductorPhase> = new Set(['active', 'paused', 'blocked', 'complete'])
const MODES: ReadonlySet<ConductorMode> = new Set(['serial', 'parallel'])
const TASK_STATUSES: ReadonlySet<TaskStatus> = new Set(['todo', 'in-progress', 'done', 'blocked'])
const REPORT_STATUSES: ReadonlySet<TaskReportStatus> = new Set(['progress', 'done', 'blocked'])

/** Mutable accumulator kept private to the pure fold. */
export interface ConductorFoldState {
  board: ConductorSnapshot | undefined
  createdAt: number | undefined
  updatedAt: number | undefined
  lastRef: ConductorRef | undefined
  seenBoardIds: Set<ConductorSnapshot['id']>
}

/**
 * Build an empty replay accumulator.
 * @returns mutable state with no current board or prior ref.
 */
export function emptyConductorFoldState(): ConductorFoldState {
  return {
    board: undefined,
    createdAt: undefined,
    updatedAt: undefined,
    lastRef: undefined,
    seenBoardIds: new Set(),
  }
}

/** Whether a value is a JSON record rather than an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Require one positive safe integer. */
function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`conductor change ${field} must be a positive safe integer`)
  }
  return value
}

/** Require one non-negative safe integer. */
function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`conductor change ${field} must be a non-negative safe integer`)
  }
  return value
}

/** Require one non-empty normalized string. */
function normalizedString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
    throw new Error(`conductor change ${field} must be a non-empty normalized string`)
  }
  return value
}

/** Decode one canonical blocker explanation. */
function decodeBlockReason(value: unknown, field: string): ConductorBlockReason | TaskBlockReason {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'code,message') {
    throw new Error(`conductor change ${field} must have exactly code and message fields`)
  }
  if (typeof value['code'] !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value['code'])) {
    throw new Error(`conductor change ${field}.code must be lower-kebab-case`)
  }
  if (typeof value['message'] !== 'string' || value['message'].trim().length === 0
    || value['message'] !== value['message'].trim()) {
    throw new Error(`conductor change ${field}.message must be non-empty and normalized`)
  }
  return { code: value['code'], message: value['message'] }
}

/** Decode one report entry. */
function decodeReportEntry(value: unknown): TaskReportEntry {
  if (!isRecord(value)) throw new Error('conductor change task report must be a record')
  const allowed = ['at', 'message', 'status', 'workerCompactions', 'workerSessionId']
  if (Object.keys(value).sort().join(',') !== allowed.sort().join(',')) {
    throw new Error(`conductor change task report must have exactly ${allowed.sort().join(',')} fields`)
  }
  const status = value['status']
  if (typeof status !== 'string' || !REPORT_STATUSES.has(status as TaskReportStatus)) {
    throw new Error('conductor change task report status is invalid')
  }
  return {
    status: status as TaskReportStatus,
    message: normalizedString(value['message'], 'task report message'),
    at: nonNegativeInteger(value['at'], 'task report at'),
    workerSessionId: normalizedString(value['workerSessionId'], 'task report workerSessionId') as SessionId,
    workerCompactions: nonNegativeInteger(value['workerCompactions'], 'task report workerCompactions'),
  }
}

/** Decode and validate one task snapshot. */
function decodeTask(value: unknown): TaskSnapshot {
  if (!isRecord(value)) throw new Error('conductor change task must be a record')
  const statusValue = value['status']
  if (typeof statusValue !== 'string' || !TASK_STATUSES.has(statusValue as TaskStatus)) {
    throw new Error('conductor change task status is invalid')
  }
  const status = statusValue as TaskStatus
  const keys = ['dependsOn', 'description', 'id', 'reports', 'status', 'title']
  const optional = [
    ...value['assignee'] !== undefined ? ['assignee'] : [],
    ...status === 'blocked' ? ['blockedReason'] : [],
  ]
  if (Object.keys(value).sort().join(',') !== [...keys, ...optional].sort().join(',')) {
    throw new Error('conductor change task has unexpected fields for its status')
  }
  const dependsOn = value['dependsOn']
  if (!Array.isArray(dependsOn) || dependsOn.some(dep => typeof dep !== 'string' || dep.length === 0)) {
    throw new Error('conductor change task dependsOn must be an array of non-empty task ids')
  }
  if (new Set(dependsOn).size !== dependsOn.length) {
    throw new Error('conductor change task dependsOn must not repeat task ids')
  }
  const reports = value['reports']
  if (!Array.isArray(reports)) throw new Error('conductor change task reports must be an array')
  const assignee = value['assignee']
  if (assignee !== undefined && (typeof assignee !== 'string' || assignee.length === 0)) {
    throw new Error('conductor change task assignee must be a non-empty session id')
  }
  const decoded: TaskSnapshot = {
    id: TaskId(normalizedString(value['id'], 'task id')),
    title: normalizedString(value['title'], 'task title'),
    description: normalizedString(value['description'], 'task description'),
    status,
    dependsOn: dependsOn.map(dep => TaskId(String(dep))),
    ...assignee !== undefined ? { assignee: assignee as SessionId } : {},
    ...status === 'blocked'
      ? { blockedReason: decodeBlockReason(value['blockedReason'], 'task blockedReason') }
      : {},
    reports: reports.map(decodeReportEntry),
  }
  return decoded
}

/** Decode and validate one board snapshot. */
function decodeSnapshot(value: unknown): ConductorSnapshot {
  if (!isRecord(value)) throw new Error('conductor change board must be a record')
  const phaseValue = value['phase']
  if (typeof phaseValue !== 'string' || !PHASES.has(phaseValue as ConductorPhase)) {
    throw new Error('conductor change board phase is invalid')
  }
  const phase = phaseValue as ConductorPhase
  const keys = [
    'conductorSessionId',
    'handoverCount',
    'id',
    'maxParallelWorkers',
    'mode',
    'objective',
    'phase',
    'planOutline',
    'revision',
    'tasks',
  ]
  const optional = [...phase === 'blocked' ? ['blockedReason'] : []]
  if (Object.keys(value).sort().join(',') !== [...keys, ...optional].sort().join(',')) {
    throw new Error('conductor change board has unexpected fields for its phase')
  }
  const modeValue = value['mode']
  if (typeof modeValue !== 'string' || !MODES.has(modeValue as ConductorMode)) {
    throw new Error('conductor change board mode is invalid')
  }
  const planOutline = value['planOutline']
  if (typeof planOutline !== 'string' || planOutline !== planOutline.trim()) {
    throw new Error('conductor change board planOutline must be a normalized string')
  }
  const tasksValue = value['tasks']
  if (!Array.isArray(tasksValue)) throw new Error('conductor change board tasks must be an array')
  const tasks = tasksValue.map(decodeTask)
  const seen = new Set<string>()
  for (const task of tasks) {
    if (seen.has(task.id)) throw new Error(`conductor change board repeats task id "${task.id}"`)
    seen.add(task.id)
  }
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!seen.has(dep)) throw new Error(`conductor change task "${task.id}" depends on unknown task "${dep}"`)
    }
  }
  assertAcyclic(tasks)
  return {
    id: ConductorId(normalizedString(value['id'], 'board id')),
    revision: positiveInteger(value['revision'], 'board revision'),
    objective: normalizedString(value['objective'], 'board objective'),
    planOutline,
    mode: modeValue as ConductorMode,
    maxParallelWorkers: positiveInteger(value['maxParallelWorkers'], 'board maxParallelWorkers'),
    phase,
    ...phase === 'blocked'
      ? { blockedReason: decodeBlockReason(value['blockedReason'], 'board blockedReason') }
      : {},
    conductorSessionId: normalizedString(value['conductorSessionId'], 'board conductorSessionId') as SessionId,
    handoverCount: nonNegativeInteger(value['handoverCount'], 'board handoverCount'),
    tasks,
  }
}

/** Reject a dependency cycle among a snapshot's tasks. */
function assertAcyclic(tasks: readonly TaskSnapshot[]): void {
  const byId = new Map<string, TaskSnapshot>(tasks.map(task => [task.id, task]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): void => {
    if (visited.has(id)) return
    if (visiting.has(id)) throw new Error(`conductor change task dependencies contain a cycle through "${id}"`)
    visiting.add(id)
    const task = byId.get(id)
    /* v8 ignore next -- decodeTask validated every dependency against the snapshot's task ids */
    if (task !== undefined) {
      for (const dep of task.dependsOn) visit(dep)
    }
    visiting.delete(id)
    visited.add(id)
  }
  for (const task of tasks) visit(task.id)
}

/** Decode one ref. */
function decodeRef(value: unknown): ConductorRef {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'id,revision') {
    throw new Error('conductor clear tombstone must have exactly id and revision fields')
  }
  return {
    id: ConductorId(normalizedString(value['id'], 'cleared id')),
    revision: positiveInteger(value['revision'], 'cleared.revision'),
  }
}

/**
 * Decode a value that declares itself as a conductor change. Unrelated values
 * return `undefined`; malformed conductor changes fail replay loudly.
 * @param value - candidate source change.
 * @returns validated conductor change or `undefined` for another value kind.
 */
export function decodeConductorChange(value: unknown): ConductorChangeMeta | undefined {
  if (!isRecord(value) || value['kind'] !== 'conductor/change') return undefined
  if (value['version'] !== CONDUCTOR_CHANGE_VERSION) {
    throw new Error(`unsupported conductor change version ${String(value['version'])}`)
  }
  if (value['operation'] === 'clear') {
    const allowed = ['cleared', 'clearedAt', 'kind', 'operation', 'version']
    if (Object.keys(value).sort().join(',') !== allowed.sort().join(',')) {
      throw new Error(`conductor clear change must have exactly ${allowed.sort().join(',')} fields`)
    }
    return {
      kind: 'conductor/change',
      version: CONDUCTOR_CHANGE_VERSION,
      operation: 'clear',
      cleared: decodeRef(value['cleared']),
      clearedAt: nonNegativeInteger(value['clearedAt'], 'clearedAt'),
    } satisfies ConductorClearChangeMeta
  }
  if (typeof value['operation'] !== 'string'
    || !SNAPSHOT_OPERATIONS.has(value['operation'] as Exclude<ConductorOperation, 'clear'>)) {
    throw new Error('conductor change operation is invalid')
  }
  const allowed = ['board', 'createdAt', 'kind', 'operation', 'updatedAt', 'version']
  if (Object.keys(value).sort().join(',') !== allowed.sort().join(',')) {
    throw new Error(`conductor snapshot change must have exactly ${allowed.sort().join(',')} fields`)
  }
  const createdAt = nonNegativeInteger(value['createdAt'], 'createdAt')
  const updatedAt = nonNegativeInteger(value['updatedAt'], 'updatedAt')
  if (updatedAt < createdAt) throw new Error('conductor change updatedAt cannot precede createdAt')
  return {
    kind: 'conductor/change',
    version: CONDUCTOR_CHANGE_VERSION,
    operation: value['operation'] as Exclude<ConductorOperation, 'clear'>,
    board: decodeSnapshot(value['board']),
    createdAt,
    updatedAt,
  } satisfies ConductorSnapshotChangeMeta
}

/** Require the definition fields not exempted by an operation to match. */
function requireSameDefinition(
  current: ConductorSnapshot,
  next: ConductorSnapshot,
  operation: ConductorOperation,
  mutable: readonly ('objective' | 'planOutline' | 'mode' | 'maxParallelWorkers')[] = [],
): void {
  const exempt = new Set(mutable)
  if ((!exempt.has('objective') && next.objective !== current.objective)
    || (!exempt.has('planOutline') && next.planOutline !== current.planOutline)
    || (!exempt.has('mode') && next.mode !== current.mode)
    || (!exempt.has('maxParallelWorkers') && next.maxParallelWorkers !== current.maxParallelWorkers)
    || next.conductorSessionId !== current.conductorSessionId
    || next.handoverCount !== current.handoverCount) {
    throw new Error(`conductor ${operation} cannot change the board definition`)
  }
}

/** Require one exact next revision of the current board. */
function requireNextRevision(current: ConductorSnapshot, next: ConductorRef, operation: ConductorOperation): void {
  if (next.id !== current.id || next.revision !== current.revision + 1) {
    throw new Error(`conductor ${operation} must advance the current board by one revision`)
  }
}

/** Require two task arrays to be identical by id and content. */
function requireSameTasks(current: readonly TaskSnapshot[], next: readonly TaskSnapshot[], operation: ConductorOperation): void {
  if (JSON.stringify(current) !== JSON.stringify(next)) {
    throw new Error(`conductor ${operation} cannot change the task set`)
  }
}

/** Find the one task whose content differs between two same-id task arrays. */
function differingTask(
  current: readonly TaskSnapshot[],
  next: readonly TaskSnapshot[],
  operation: ConductorOperation,
): { current: TaskSnapshot; next: TaskSnapshot } | undefined {
  if (current.length !== next.length) {
    throw new Error(`conductor ${operation} must preserve the task count`)
  }
  const currentById = new Map(current.map(task => [task.id, task]))
  const nextById = new Map(next.map(task => [task.id, task]))
  for (const task of next) {
    if (!currentById.has(task.id)) throw new Error(`conductor ${operation} cannot add a task`)
  }
  /* v8 ignore next 2 -- a same-length replacement set trips the add check above before removal can differ */
  for (const task of current) {
    if (!nextById.has(task.id)) throw new Error(`conductor ${operation} cannot remove a task`)
  }
  const differs: { current: TaskSnapshot; next: TaskSnapshot }[] = []
  for (const task of current) {
    const counterpart = nextById.get(task.id)
    /* v8 ignore next -- the membership loops above established every id is shared */
    if (counterpart === undefined) continue
    if (JSON.stringify(task) !== JSON.stringify(counterpart)) {
      differs.push({ current: task, next: counterpart })
    }
  }
  if (differs.length === 0) throw new Error(`conductor ${operation} must change at least one task`)
  if (differs.length > 1) throw new Error(`conductor ${operation} must change exactly one task`)
  /* v8 ignore start -- differs.length === 1 makes the indexed read definite */
  const diff = differs[0]
  if (diff === undefined) throw new Error(`conductor ${operation} must change exactly one task`)
  /* v8 ignore stop */
  return diff
}

/** Validate the one-task mutation rules of a task-level operation. */
function validateTaskMutation(
  operation: Exclude<ConductorOperation, 'init' | 'edit' | 'set-mode' | 'pause' | 'resume' | 'complete' | 'block' | 'clear' | 'handover'>,
  current: ConductorSnapshot,
  next: ConductorSnapshot,
): void {
  const diff = differingTask(current.tasks, next.tasks, operation)
  /* v8 ignore next -- differingTask throws when no task differs */
  if (diff === undefined) return
  const { current: before, next: after } = diff
  const stable: Record<string, unknown> = {
    title: before.title,
    description: before.description,
    dependsOn: before.dependsOn,
    id: before.id,
    reports: before.reports,
    assignee: before.assignee,
  }
  /* v8 ignore next 2 -- the switch above never routes task-create into the one-task mutation validator */
  if (operation === 'task-create') {
    throw new Error('conductor task-create cannot run as a one-task mutation')
  }
  if (operation === 'task-edit') {
    for (const key of Object.keys(stable)) {
      if (key === 'title' || key === 'description' || key === 'dependsOn') continue
      if (JSON.stringify((after as unknown as Record<string, unknown>)[key]) !== JSON.stringify(stable[key])) {
        throw new Error(`conductor task-edit cannot change the "${key}" field`)
      }
    }
    // Status and blocked reason are not part of the stable map because the
    // task-status op mutates them; an edit must keep both untouched.
    if (after.status !== before.status
      || JSON.stringify(after.blockedReason) !== JSON.stringify(before.blockedReason)) {
      throw new Error('conductor task-edit cannot change the task status')
    }
    return
  }
  if (operation === 'task-assign') {
    for (const key of Object.keys(stable)) {
      if (key === 'assignee') continue
      if (JSON.stringify((after as unknown as Record<string, unknown>)[key]) !== JSON.stringify(stable[key])) {
        throw new Error(`conductor task-assign cannot change the "${key}" field`)
      }
    }
    // Reassigning a blocked task clears its blocker; assigning never sets one.
    /* v8 ignore next -- decodeTask rejects a blockedReason on any status but blocked, so the fold never sees one here */
    if (after.blockedReason !== undefined) throw new Error('conductor task-assign must clear a blocked reason')
    if (after.assignee !== undefined && after.status !== 'in-progress') {
      throw new Error('conductor task-assign must mark an assigned task in-progress')
    }
    if (after.assignee === undefined && after.status !== 'todo') {
      throw new Error('conductor task-assign must return an unassigned task to todo')
    }
    return
  }
  if (operation === 'task-status') {
    for (const key of Object.keys(stable)) {
      // The stable map never carries status or blockedReason; the skip keeps
      // the shared loop shape while those fields are validated below.
      /* v8 ignore next -- Object.keys(stable) yields only definition fields */
      if (key === 'status' || key === 'blockedReason') continue
      if (JSON.stringify((after as unknown as Record<string, unknown>)[key]) !== JSON.stringify(stable[key])) {
        throw new Error(`conductor task-status cannot change the "${key}" field`)
      }
    }
    if (after.status === before.status) throw new Error('conductor task-status must change the task status')
    validateStatusPair(before, after)
    return
  }
  /* v8 ignore start -- task-report is the final member of the closed union */
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- the runtime check keeps the closed union exhaustive for future members
  if (operation !== 'task-report') {
    operation satisfies never
    throw new Error('unknown conductor task operation')
  }
  /* v8 ignore stop */
  for (const key of Object.keys(stable)) {
    if (key === 'status' || key === 'reports' || key === 'blockedReason') continue
    if (JSON.stringify((after as unknown as Record<string, unknown>)[key]) !== JSON.stringify(stable[key])) {
      throw new Error(`conductor task-report cannot change the "${key}" field`)
    }
  }
  if (after.reports.length < 1 || after.reports.length > before.reports.length + 1) {
    throw new Error('conductor task-report must append at most one report entry')
  }
  const kept = after.reports.slice(0, -1)
  if (before.reports.slice(before.reports.length - kept.length).some((entry, index) =>
    JSON.stringify(entry) !== JSON.stringify(kept[index]))) {
    throw new Error('conductor task-report must retain the newest prior reports')
  }
  if (before.reports.some(entry => JSON.stringify(entry) === JSON.stringify(after.reports[after.reports.length - 1]))) {
    throw new Error('conductor task-report must append a new report entry')
  }
  const reported = after.reports[after.reports.length - 1]?.status
  const expected: TaskStatus = reported === 'done' ? 'done' : reported === 'blocked' ? 'blocked' : 'in-progress'
  if (after.status !== expected && !(reported === 'progress' && after.status === 'blocked')) {
    throw new Error('conductor task-report status must match the reported status')
  }
  validateStatusPair(before, after)
}

/** Validate a status pair produced by a report or a direct status change. */
function validateStatusPair(before: TaskSnapshot, after: TaskSnapshot): void {
  /* v8 ignore next 2 -- decodeTask rejects a blockedReason on any status but blocked, so the fold never sees one outside it */
  if (after.blockedReason !== undefined && after.status !== 'blocked') {
    throw new Error('conductor task blockedReason is present outside the blocked status')
  }
  /* v8 ignore next 2 -- decodeTask requires a blockedReason exactly on the blocked status, so the fold never sees one missing */
  if (after.status === 'blocked' && after.blockedReason === undefined) {
    throw new Error('conductor task blocked status requires a blockedReason')
  }
  if (before.status === 'done' && after.status !== 'done') {
    throw new Error('conductor task cannot leave the done status')
  }
}

/** Validate one non-init snapshot operation against the preceding projection. */
function validateSnapshotTransition(
  state: ConductorFoldState,
  change: ConductorSnapshotChangeMeta,
  current: ConductorSnapshot,
): void {
  const next = change.board
  requireNextRevision(current, next, change.operation)
  /* v8 ignore next -- a current board established by this fold always has an updatedAt */
  if (state.updatedAt === undefined) throw new Error('current conductor fold lacks updatedAt')
  if (change.createdAt !== state.createdAt || change.updatedAt < state.updatedAt) {
    throw new Error(`conductor ${change.operation} does not preserve the current counters and timestamps`)
  }
  switch (change.operation) {
    /* v8 ignore next 2 -- init is applied before the transition validator is consulted */
    case 'init':
      throw new Error('conductor init cannot be validated as a current-board transition')
    case 'edit': {
      requireSameDefinition(current, next, change.operation, ['objective', 'planOutline'])
      requireSameTasks(current.tasks, next.tasks, change.operation)
      if (next.phase !== current.phase
        || JSON.stringify(next.blockedReason) !== JSON.stringify(current.blockedReason)) {
        throw new Error('conductor edit cannot change phase or blocked reason')
      }
      if (next.objective === current.objective && next.planOutline === current.planOutline) {
        throw new Error('conductor edit must change the objective or the plan outline')
      }
      break
    }
    case 'set-mode': {
      requireSameDefinition(current, next, change.operation, ['mode', 'maxParallelWorkers'])
      requireSameTasks(current.tasks, next.tasks, change.operation)
      if (next.phase !== current.phase
        || JSON.stringify(next.blockedReason) !== JSON.stringify(current.blockedReason)) {
        throw new Error('conductor set-mode cannot change phase or blocked reason')
      }
      if (next.mode === current.mode && next.maxParallelWorkers === current.maxParallelWorkers) {
        throw new Error('conductor set-mode must change the mode or the parallel cap')
      }
      break
    }
    case 'pause':
      requireSameDefinition(current, next, change.operation)
      requireSameTasks(current.tasks, next.tasks, change.operation)
      if (current.phase !== 'active' || next.phase !== 'paused') throw new Error('conductor pause has an invalid phase transition')
      break
    case 'resume': {
      requireSameDefinition(current, next, change.operation)
      requireSameTasks(current.tasks, next.tasks, change.operation)
      const resumable: ReadonlySet<ConductorPhase> = new Set(['active', 'paused', 'blocked'])
      if (!resumable.has(current.phase) || next.phase !== 'active') {
        throw new Error('conductor resume has an invalid phase transition')
      }
      /* v8 ignore next 2 -- decodeSnapshot rejects a blockedReason on any phase but blocked, so resume never sees one to clear */
      if (next.blockedReason !== undefined) throw new Error('conductor resume must clear the blocked reason')
      break
    }
    case 'complete':
      requireSameDefinition(current, next, change.operation)
      requireSameTasks(current.tasks, next.tasks, change.operation)
      if (current.phase === 'complete' || next.phase !== 'complete') throw new Error('conductor complete has an invalid phase transition')
      /* v8 ignore next 2 -- decodeSnapshot rejects a blockedReason on any phase but blocked, so complete never sees one to clear */
      if (next.blockedReason !== undefined) throw new Error('conductor complete must clear the blocked reason')
      break
    case 'block':
      requireSameDefinition(current, next, change.operation)
      requireSameTasks(current.tasks, next.tasks, change.operation)
      if (current.phase !== 'active' || next.phase !== 'blocked') {
        throw new Error('conductor block has an invalid phase transition')
      }
      /* v8 ignore next 2 -- decodeSnapshot requires a blockedReason exactly on the blocked phase, so the fold never sees one missing */
      if (next.blockedReason === undefined) throw new Error('conductor block requires a blocked reason')
      break
    case 'task-create': {
      requireSameDefinition(current, next, change.operation)
      if (current.tasks.length + 1 !== next.tasks.length) {
        throw new Error('conductor task-create must add exactly one task')
      }
      const existing = new Set(current.tasks.map(task => task.id))
      const added: TaskSnapshot[] = []
      for (const task of next.tasks) {
        if (existing.has(task.id)) continue
        added.push(task)
      }
      if (added.length !== 1) throw new Error('conductor task-create must add exactly one new task id')
      const created = added[0]
      /* v8 ignore next -- the added task is not in the current set by construction */
      if (created === undefined) throw new Error('conductor task-create added no task')
      if (created.status !== 'todo' || created.reports.length !== 0 || created.assignee !== undefined) {
        throw new Error('conductor task-create must add a fresh todo task without reports or assignee')
      }
      const nextById = new Map(next.tasks.map(task => [task.id, task]))
      for (const task of current.tasks) {
        if (JSON.stringify(task) !== JSON.stringify(nextById.get(task.id))) {
          throw new Error('conductor task-create must leave existing tasks unchanged')
        }
      }
      break
    }
    case 'task-edit':
    case 'task-status':
    case 'task-assign':
    case 'task-report':
      requireSameDefinition(current, next, change.operation)
      validateTaskMutation(change.operation, current, next)
      break
    case 'handover': {
      if (next.phase !== current.phase
        || JSON.stringify(next.blockedReason) !== JSON.stringify(current.blockedReason)
        || next.objective !== current.objective || next.planOutline !== current.planOutline
        || next.mode !== current.mode || next.maxParallelWorkers !== current.maxParallelWorkers) {
        throw new Error('conductor handover cannot change the board definition')
      }
      if (next.conductorSessionId === current.conductorSessionId) {
        throw new Error('conductor handover must move the conductor role to a different session')
      }
      if (next.handoverCount !== current.handoverCount + 1) {
        throw new Error('conductor handover must increment the handover count by one')
      }
      requireSameTasks(current.tasks, next.tasks, change.operation)
      break
    }
    /* v8 ignore start -- ConductorOperation is closed and every member is handled above */
    default:
      change.operation satisfies never
      throw new Error('unknown conductor snapshot operation')
    /* v8 ignore stop */
  }
}

/**
 * Return the revision identity carried by a snapshot or tombstone.
 * @param change - decoded board mutation.
 * @returns stable identity used to reconcile a deferred change with its log event.
 */
export function conductorChangeRef(change: ConductorChangeMeta): ConductorRef {
  return change.operation === 'clear'
    ? change.cleared
    : { id: change.board.id, revision: change.board.revision }
}

/**
 * Validate and apply one decoded change to a mutable accumulator.
 * @param state - preceding durable board projection.
 * @param change - decoded full snapshot or clear tombstone.
 */
export function applyConductorChange(state: ConductorFoldState, change: ConductorChangeMeta): void {
  const ref = conductorChangeRef(change)
  if (change.operation === 'clear') {
    const current = state.board
    if (current === undefined) throw new Error('conductor clear requires a current board')
    requireNextRevision(current, change.cleared, change.operation)
    /* v8 ignore next -- a current board established by this fold always has an updatedAt */
    if (state.updatedAt === undefined) throw new Error('current conductor fold lacks updatedAt')
    if (change.clearedAt < state.updatedAt) {
      throw new Error('conductor clear timestamp cannot precede the current board update')
    }
    state.board = undefined
    state.createdAt = undefined
    state.updatedAt = undefined
    state.lastRef = ref
    return
  }
  if (change.operation === 'init') {
    if (change.board.revision !== 1 || change.board.phase !== 'active'
      || change.board.handoverCount !== 0 || change.board.tasks.length !== 0
      || (state.board !== undefined && state.board.phase !== 'complete')
      || state.seenBoardIds.has(change.board.id)) {
      throw new Error('conductor init requires a fresh active revision-one board with no tasks or handovers')
    }
    state.seenBoardIds.add(change.board.id)
  } else {
    const current = state.board
    if (current === undefined) {
      if (change.operation === 'handover') {
        // The successor session installs the transferred board from an empty
        // fold; the same change payload transitions the retiring session.
        if (change.board.handoverCount < 1) {
          throw new Error('conductor handover install requires a non-zero handover count')
        }
        state.seenBoardIds.add(change.board.id)
      } else {
        throw new Error(`conductor ${change.operation} requires a current board`)
      }
    } else {
      validateSnapshotTransition(state, change, current)
    }
  }
  state.board = change.board
  state.createdAt = change.createdAt
  state.updatedAt = change.updatedAt
  state.lastRef = ref
}

/**
 * Apply one session event to the strict durable conductor fold.
 * @param state - mutable fold accumulator.
 * @param event - next event in sequence order.
 */
export function applyConductorEvent(state: ConductorFoldState, event: SessionEvent): void {
  if (event.type === 'conductor/change') {
    const change = decodeConductorChange(event.data)
    /* v8 ignore next -- the event's declared payload always identifies itself as a conductor change. */
    if (change === undefined) throw new Error(`conductor change at session event ${event.seq} has an invalid kind`)
    applyConductorChange(state, change)
  }
}

/**
 * Fold current board state from a contiguous session event log.
 * @param events - session events in sequence order.
 * @returns a fresh durable projection; activation is deliberately absent.
 */
export function foldConductor(events: readonly SessionEvent[]): FoldedConductor {
  const state = emptyConductorFoldState()
  for (const event of events) applyConductorEvent(state, event)
  return {
    ...state.board === undefined ? {} : { board: { ...state.board, tasks: state.board.tasks.map(task => ({ ...task })) } },
    ...state.createdAt === undefined ? {} : { createdAt: state.createdAt },
    ...state.updatedAt === undefined ? {} : { updatedAt: state.updatedAt },
    ...state.lastRef === undefined ? {} : { lastRef: { ...state.lastRef } },
  }
}
