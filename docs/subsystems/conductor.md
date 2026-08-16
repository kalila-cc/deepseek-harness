# Conductor

English | [中文](conductor.zh.md)

The conductor seam orchestrates multi-window tasks: a **conductor window** holds an event-sourced task board, worker windows execute tasks as continuable subagents, and the round driver advances the work automatically. Service Definition and driver: [`packages/conductor/conductor`](../../packages/conductor/conductor/README.md), [`packages/conductor/conductor-round-driver`](../../packages/conductor/conductor-round-driver/README.md). Model-facing Consumers: [`packages/conductor/tool-conductor`](../../packages/conductor/tool-conductor/README.md) (conductor tools), [`packages/conductor/tool-task-report`](../../packages/conductor/tool-task-report/README.md) (worker reporting). The shipped `conductor` agent preset mounts the tools and persona; worker children join the same preset with the conductor-only tools restricted away.

## Board state

The board is event-sourced in the conductor session's log via `conductor/change` events, with the same full-snapshot compare-and-set discipline as [goals](goal.md). A snapshot carries the objective, the plan outline, the scheduling `mode` (`serial` | `parallel`), the parallel cap, the lifecycle `phase`, the current `conductorSessionId`, the `handoverCount`, and the task list. Each task carries its status (`todo` | `in-progress` | `done` | `blocked`), its dependency ids, its assignee session, and a bounded report history. The strict fold validates exact key sets, dependency resolvability and acyclicity, revision/timestamp monotonicity, per-operation field-touch rules, and report-history suffixes.

## Roles and routing

- **Conductor**: the session named by `board.conductorSessionId`. Only a top-level session may `init`; conductor-only mutations reject any other caller.
- **Worker**: a continuable subagent created by `spawnWorkers` with a deterministic briefing. `report` validates the caller against the task's assignee, commits into the **current** conductor's board, and delivers a framed message that wakes the conductor window.
- **Successor window**: `handover` creates a fresh continuable child, transfers the full board snapshot into its log, and retires the caller. The same change payload commits to both sessions. Worker reports route through the parent-chain lineage walk, so they keep landing on the current conductor after handovers.

## Scheduling and activation

Ready tasks are those whose dependencies are all done. The driver acts at conductor quiescence when the board is active and armed: it hands over after too many compactions (`handoverAfterCompactions`), spawns workers per mode, and completes or blocks the board when nothing can proceed, waking the conductor to report to the user. Activation is process-local like goals, but a session that resumes as the current conductor of an active board re-arms automatically.

Sources: [`packages/conductor/conductor/src/types.ts`](../../packages/conductor/conductor/src/types.ts), [`src/domain.ts`](../../packages/conductor/conductor/src/domain.ts), [`src/fold.ts`](../../packages/conductor/conductor/src/fold.ts), [`src/index.ts`](../../packages/conductor/conductor/src/index.ts)

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxconductor--conductorservice"></a>

### `ctx.conductor` — `ConductorService`

Conductor service (`ctx.conductor`): the event-sourced task board of one conductor window, its worker scheduling, delivery, and handover.

```ts cordis-catalog
/**
 * Read the board of one exact live agent's session.
 * @param agent - the live agent whose session log holds the board.
 * @returns a fresh view or `undefined` when its session has no board.
 * @throws {@link ConductorError} when the agent is not the registry's live instance.
 */
get(agent: Agent): ConductorView | undefined

/**
 * Remove process-local continuation authority without changing durable
 * board phase or revision. Lifecycle owners use this before unloading a
 * driver; a later session-start or resume re-arms the current conductor.
 * @param agent - owning live agent.
 * @returns a fresh disarmed view, or `undefined` when no board is current.
 */
disarm(agent: Agent): ConductorView | undefined

/**
 * Create and arm a board; the calling session becomes the conductor. A
 * completed board may be replaced; every other current phase must be
 * cleared or resumed instead. Only a top-level session (not a delegated
 * worker) may become a conductor.
 * @param agent - owning live agent.
 * @param request - objective, mode, plan outline, and optional parallel cap.
 * @returns the created live view.
 */
init(agent: Agent, request: InitConductorRequest): ConductorView

/**
 * Edit objective and/or plan outline without changing phase, mode, or tasks.
 * @param agent - owning live agent (the current conductor).
 * @param ref - expected current revision.
 * @param request - at least one replacement field.
 * @returns the edited view.
 */
edit(agent: Agent, ref: ConductorRef, request: EditConductorRequest): ConductorView

/**
 * Switch the scheduling mode and/or the parallel cap without changing the
 * board definition or tasks.
 * @param agent - owning live agent (the current conductor).
 * @param ref - expected current revision.
 * @param mode - the new scheduling mode.
 * @param maxParallelWorkers - the new parallel cap.
 * @returns the switched view.
 */
setMode(agent: Agent, ref: ConductorRef, mode: ConductorMode, maxParallelWorkers?: number): ConductorView

/**
 * Pause an active board and disarm automatic advancement.
 * @param agent - owning live agent (the current conductor).
 * @param ref - expected current revision.
 * @returns the paused view.
 */
pause(agent: Agent, ref: ConductorRef): ConductorView

/**
 * Resume and arm a stopped board, or rearm an active board after a
 * session-start edge.
 * @param agent - owning live agent (the current conductor).
 * @param ref - expected current revision.
 * @returns the active view.
 */
resume(agent: Agent, ref: ConductorRef): ConductorView

/**
 * Mark a current non-complete board complete and disarm it.
 * @param agent - owning live agent (the current conductor).
 * @param ref - expected current revision.
 * @returns the completed view.
 */
complete(agent: Agent, ref: ConductorRef): ConductorView

/**
 * Mark an active board blocked and disarm it.
 * @param agent - owning live agent (the current conductor).
 * @param ref - expected current revision.
 * @param reason - policy-owned stable code and human-readable explanation.
 * @returns the blocked view with its durable reason.
 */
block(agent: Agent, ref: ConductorRef, reason: TaskBlockReason): ConductorView

/**
 * Clear the current board while retaining a durable tombstone and history.
 * @param agent - owning live agent (the current conductor).
 * @param ref - expected current revision.
 * @returns the tombstone ref whose revision is one past the cleared snapshot.
 */
clear(agent: Agent, ref: ConductorRef): ConductorRef

/**
 * Add one task to the board. Dependencies must name existing task ids and
 * must not create a cycle.
 * @param agent - owning live agent (the current conductor).
 * @param ref - expected current revision.
 * @param request - title, description, and optional existing-task dependencies.
 * @returns the updated view.
 */
createTask(agent: Agent, ref: ConductorRef, request: CreateTaskRequest): ConductorView

/**
 * Edit one task's title, description, or dependencies without changing its
 * status or reports.
 * @param agent - owning live agent (the current conductor).
 * @param ref - expected current revision.
 * @param taskId - the task to edit.
 * @param request - at least one replacement field.
 * @returns the updated view.
 */
editTask(agent: Agent, ref: ConductorRef, taskId: TaskId, request: EditTaskRequest): ConductorView

/**
 * Set one task's status. Blocking requires a reason; leaving the done
 * status is rejected.
 * @param agent - owning live agent (the current conductor).
 * @param ref - expected current revision.
 * @param taskId - the task to update.
 * @param status - the target status.
 * @param reason - required exactly when `status` is `blocked`.
 * @returns the updated view.
 */
setTaskStatus(agent: Agent, ref: ConductorRef, taskId: TaskId, status: TaskStatus, reason?: unknown): ConductorView

/**
 * Return one task to the todo status without an assignee so the scheduler
 * assigns a fresh worker window. Prior reports are retained for the next
 * worker's briefing. A done task cannot be reassigned.
 * @param agent - owning live agent (the current conductor).
 * @param ref - expected current revision.
 * @param taskId - the task to reassign.
 * @returns the updated view.
 */
reassignTask(agent: Agent, ref: ConductorRef, taskId: TaskId): ConductorView

/**
 * Receive a worker's report about its assigned task: validate the worker,
 * commit the report into the current conductor's board, and deliver the
 * framed report message to the current conductor window.
 * @param worker - exact live reporting worker agent.
 * @param request - task id, claimed status, and self-contained message.
 * @returns the accepted report delivery's message id.
 * @throws {@link ConductorError} when the worker is not the task's assignee,
 *   the task is already done, or no live current conductor exists.
 */
report(worker: Agent, request: TaskReportRequest): ReportResult

/**
 * Deliver one message from the current conductor to one of its workers.
 * Cold-resumes the worker through the subagent service when the conductor
 * is the worker's durable direct parent; otherwise the worker agent must be
 * live.
 * @param agent - owning live agent (the current conductor).
 * @param workerSessionId - the worker session to deliver to.
 * @param text - the message content.
 * @returns the accepted delivery's message id.
 */
async deliver(agent: Agent, workerSessionId: SessionId, text: string): Promise<DeliverResult>

/**
 * Hand the conductor role to a fresh window: create a continuable child,
 * transfer the full board snapshot into its log, and retire this window.
 * The same change payload commits to both sessions, so each side's log
 * reconstructs the same post-handover board.
 * @param agent - owning live agent (the current conductor).
 * @param reason - why the window is handing over.
 * @returns the successor window's session id and briefing message id.
 */
async handover(agent: Agent, reason: string): Promise<HandoverResult>

/**
 * Spawn worker windows for the currently ready tasks, honoring the board's
 * scheduling mode: the first ready task in serial mode, ready tasks up to
 * the parallel cap otherwise. Tasks whose dependencies are blocked are
 * marked blocked first.
 * @param agent - owning live agent (the current conductor).
 * @returns the spawned worker identities in assignment order.
 * @throws {@link ConductorError} when the board is not active and armed or a spawn fails.
 */
async spawnWorkers(agent: Agent): Promise<SpawnedWorker[]>

/**
 * Count the context compactions a session has undergone.
 * @param session - the session to count.
 * @returns the number of `compaction/summary` events in its log.
 */
compactionCount(session: Session): number
```

Types: [Agent](core.md) · [Session](session.md) · [SessionId](core.md)

Source: [`packages/conductor/conductor/src/index.ts:281`](../../packages/conductor/conductor/src/index.ts)

<a id="conductor-events"></a>

### `conductor/*` events

<a id="conductorchanged--emit"></a>

#### `conductor/changed` — emit

Board mutation accepted into one session's log. The matching `conductor/change` session event has already committed. Listener failures are contained. Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.

```ts cordis-catalog
/**
 * Board mutation accepted into one session's log. The matching
 * `conductor/change` session event has already committed. Listener
 * failures are contained. Scope-filtered dispatch (`@deepseek-ai/dsh-scope`):
 * agent-scoped listeners receive only that agent.
 * @param payload.agent - agent whose session owns the board change.
 * @param payload.change - fresh current projection or clear tombstone.
 * @mode emit
 */
'conductor/changed'(this: import('@deepseek-ai/dsh-scope').Scoped<Agent>, payload: { agent: Agent change: ConductorChanged }): void
```

Types: [Agent](core.md) · [Scoped](scope.md)

Source: [`packages/conductor/conductor/src/domain.ts:162`](../../packages/conductor/conductor/src/domain.ts)
<!-- END GENERATED cordis-surface -->
