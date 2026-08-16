/**
 * Deterministic model-facing text for the conductor domain: worker briefings,
 * the handover briefing, report framing, and driver notices. All of it is
 * built from board state alone, so every prompt is reconstructable from the
 * log and needs no model input.
 * @module @deepseek-ai/dsh-conductor
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConductorView, TaskReportStatus, TaskSnapshot } from './types.ts'

/** Render the task list of a board as compact bullet lines. */
function renderTaskLines(board: ConductorView): string {
  return board.tasks.map((task) => {
    const assignee = task.assignee !== undefined ? `, assignee=${task.assignee}` : ''
    const blocked = task.blockedReason !== undefined ? `, blocked(${task.blockedReason.code}: ${task.blockedReason.message})` : ''
    const reports = task.reports.length > 0
      ? `, reports=${task.reports.length}`
      : ''
    return `- ${task.id} [${task.status}] ${task.title}${assignee}${blocked}${reports}`
  }).join('\n')
}

/** Render prior worker reports of one task as compact bullet lines. */
function renderPriorReports(task: TaskSnapshot): string {
  if (task.reports.length === 0) return ''
  const lines = task.reports.map(report =>
    `- ${report.status} (worker ${report.workerSessionId}, compactions=${report.workerCompactions}): ${report.message}`)
  return `\nPrevious worker reports for this task:\n${lines.join('\n')}`
}

/**
 * Build the deterministic initial prompt for one worker window.
 * @param board - the current board view (post-assignment state is not required).
 * @param task - the task being assigned.
 * @param cwd - the shared workspace the worker should operate in, when known.
 * @returns the complete self-contained worker briefing text.
 */
export function renderWorkerPrompt(board: ConductorView, task: TaskSnapshot, cwd?: string): string {
  const workspace = cwd === undefined ? '' : `\nWork in the shared workspace: ${cwd}`
  return [
    `You are a subtask worker in a conductor-led team. Your one assigned task is ${task.id}: ${task.title}.`,
    '',
    `Team objective: ${board.objective}`,
    `Plan outline: ${board.planOutline === '' ? '(none)' : board.planOutline}`,
    '',
    `Task description: ${task.description}${renderPriorReports(task)}`,
    workspace,
    '',
    'Complete the task with the available tools. When you finish, call task_report once with status "done" '
      + 'and a self-contained summary of what you changed and where (files, commands, results). If a blocker '
      + 'requires the conductor\'s or the user\'s decision, call task_report with status "blocked" and the exact '
      + 'blocking condition. Use status "progress" for significant interim findings. Do not contact sibling '
      + 'workers directly; report any cross-task context to the conductor so it can relay what the other worker '
      + 'needs. Reporting does not end your '
      + 'turn: after your final report, end your turn and wait for follow-up messages; do not poll or repeat reports.',
  ].join('\n')
}

/**
 * Build the deterministic briefing prompt for a new conductor window.
 * @param board - the board view being transferred (pre-handover state).
 * @param reason - why the previous conductor window retired.
 * @param compactions - the retiring window's compaction count.
 * @returns the complete self-contained handover briefing text.
 */
export function renderHandoverBriefing(board: ConductorView, reason: string, compactions: number): string {
  return [
    'You are the new conductor window for an active conductor-orchestrated task. The previous conductor window '
      + `retired: ${reason} (it had undergone ${compactions} context compactions).`,
    '',
    `Objective: ${board.objective}`,
    `Mode: ${board.mode}${board.mode === 'parallel' ? ` (max ${board.maxParallelWorkers} parallel workers)` : ''}`,
    `Plan outline: ${board.planOutline === '' ? '(none)' : board.planOutline}`,
    `Tasks (handover ${board.handoverCount}):`,
    renderTaskLines(board),
    '',
    'The task board has been transferred to this session; read it with task_board (the transfer commit may '
      + 'land a moment after this briefing). Your responsibilities: keep the work advancing per the schedule '
      + '(ready tasks spawn automatically), re-plan when a report shows it is needed, escalate blockers that '
      + 'need the user\'s decision, and hand the role on when this window compacts too often. Announce this '
      + 'handover to the user, then continue.',
  ].join('\n')
}

/**
 * Frame a worker's report as the user message delivered to the conductor.
 * @param task - the reported task (post-report state).
 * @param reportedStatus - the status the worker claimed in the report.
 * @param message - the worker's own report text.
 * @param workerCompactions - the worker's compaction count at report time.
 * @param workerSessionId - the reporting worker's session id.
 * @returns the complete delivered report text.
 */
export function renderReportMessage(
  task: TaskSnapshot,
  reportedStatus: TaskReportStatus,
  message: string,
  workerCompactions: number,
  workerSessionId: SessionId,
): string {
  return [
    `Task report for ${task.id} (${task.title}) from worker ${workerSessionId} `
      + `(worker compactions: ${workerCompactions}):`,
    `status: ${reportedStatus}`,
    message,
  ].join('\n')
}

/** Render the notice delivered when no task can proceed. */
export function renderBlockedNotice(board: ConductorView): string {
  const blocked = board.tasks.filter(task => task.status === 'blocked')
  const lines = blocked.map((task) => {
    /* v8 ignore start -- a task marked blocked always carries the durable reason that marked it blocked */
    const message = task.blockedReason?.message ?? 'blocked'
    /* v8 ignore stop */
    return `- ${task.id} [${task.status}] ${task.title}: ${message}`
  })
  return [
    'The task board is blocked: no task can proceed. Blocked tasks:',
    lines.join('\n'),
    '',
    'Decide what to do: unblock or reassign a task (task_update), re-plan the work (conductor_update edit, '
      + 'task_create), or ask the user for a decision (ask_user_question). When the way forward is clear, '
      + 'resume the board with conductor_update action resume.',
  ].join('\n')
}

/** Render the notice delivered when every task reached done. */
export function renderCompleteNotice(board: ConductorView): string {
  return [
    `Every task in the board is complete (${board.tasks.length} tasks). The board has been marked complete.`,
    '',
    'Report the final summary to the user: what was built or decided, and where the results live.',
  ].join('\n')
}

/** Default worker persona installed into every worker window by the service. */
export const DEFAULT_WORKER_PERSONA = [
  'You are a subtask worker in a conductor-orchestrated task team.',
  'You work on exactly the task described in your briefing, in the shared workspace, using the available tools.',
  'Report to the conductor with task_report: "done" with a self-contained summary when you finish, "blocked" '
    + 'with the exact condition when you need the conductor\'s or the user\'s decision, "progress" for '
    + 'significant interim findings. Never contact sibling workers directly; send cross-task context to the '
    + 'conductor for relay. After your final report, end your turn and wait for follow-up messages; '
    + 'do not poll or repeat reports.',
].join(' ')
