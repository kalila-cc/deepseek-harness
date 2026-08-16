# Agent Note: Conductor mode — multi-window task orchestration

Status: implemented

English | [中文](2026-08-16-conductor-mode.zh.md)

## Problem

A single agent session degrades as one long-running goal grows: context compacts repeatedly, one window owns every decision, and parallel work is either scripted (workflow) or invisible to the user (ad-hoc subagents). Users wanted a first-class mode where one conductor session decomposes a goal into subtasks, tracks progress, schedules worker windows serially or in parallel, receives completion and blocker reports, and hands its role to a fresh window after too many compactions — all while every window stays message-driven and the conductor remains the single channel to the user.

## Decision

Conductor mode ships as a capability seam, an installable profile bundle, and one agent preset. The task board is event-sourced in the conductor session's log (`conductor/change`, same full-snapshot compare-and-set discipline as the goal domain), the round driver advances work at conductor quiescence, and worker and successor windows are continuable in-process subagents.

**Plane split and portable install.** `dsh-conductor` (the service) and `dsh-conductor-round-driver` mount on the host plane through one `dsh-conductor-bundle` row: the service publishes `ctx.conductor`, and a preset row that published it would collide in the root realm. The bundle carries the dependency closure for the model-facing tools (`dsh-tool-conductor`, `dsh-tool-task-report`) and materializes its packaged `conductor` composition into `${DSH_HOME}/.agent-presets/conductor`; its tool rows resolve through bundle subpath exports, so the profile has only the bundle as a direct dependency. Worker children join that preset through the ordinary `composeFrom` bind; the service restricts the eight conductor-only tools away from them (`workerToolFilter`) and installs the worker persona, so one preset serves both roles with the tool registry as the discriminator. Because an official build cannot statically catalog an out-of-tree event, bundle activation also registers `conductor/change` in the process-local known-event set before a conductor session can be opened.

**Board and roles.** Only a top-level session (no delegation depth, not a subagent origin) may `init`; the board records `conductorSessionId`. Mutations require the caller to be the current conductor; a retired window keeps its history but rejects mutations. Workers report through `report`: the service validates the caller against the task's assignee, commits the report into the **current** conductor's board (bounded `reportHistoryLimit`), records the worker's compaction count, and delivers a framed message that wakes the conductor window.

**Scheduling.** Ready tasks are those whose dependencies are all done. `spawnWorkers` first marks dependency-blocked tasks, then spawns per mode: `serial` one at a time, `parallel` up to `maxParallelWorkers`. The driver calls it automatically when the board is active and armed and the conductor agent is idle; when nothing can proceed it completes the board (all done) or blocks it (`blocked-tasks`) and wakes the conductor to escalate to the user. A spawn failure blocks the board (`spawn-failed`) so the pass cannot retry forever.

**Handover.** A conductor window whose compaction count reaches `handoverAfterCompactions` is handed over: a fresh continuable child receives the full board snapshot plus a deterministic briefing, and the same change payload commits to both sessions so each side reconstructs the same post-handover board. Worker reports route through the lineage walk, so they keep landing on the current conductor after handovers. Worker-side handover is conductor-driven: a worker whose report shows too many compactions is `reassign`ed, keeping prior reports in the next briefing.

**Activation and cadence.** Continuation eligibility is process-local (`armed`/`disarmed`) like goals, but a session that resumes as the current conductor of an active board re-arms automatically: the user's original objective is the standing authorization to keep advancing until they stop it. All advancement is message-driven — the driver acts at quiescence and reports wake windows; no window polls.

## Alternatives considered

**Fork-seeded handover.** The first design handed over by forking the conductor session, inheriting the compacted context and its compaction events. The successor's context is byte-identical to the retiring window's — the exact quality problem handover exists to solve. The shipped design creates a fresh (unseeded) child carrying a full board snapshot and a self-contained briefing, so the new window starts with a clean context and a complete state transfer. The lineage walk then routes reports to the current conductor without the successor inheriting any durable parent relationship.

**Model-driven scheduling.** Letting the conductor model call a schedule tool every round keeps the model in control but taxes tokens and depends on the model remembering to advance. The driver makes scheduling deterministic (dependencies + mode are computable) and keeps the model's role to decomposition, report triage, and user escalation. The `task_schedule` tool remains for explicit forcing.

**One worker per task, no reassign.** Workers were initially one-shot; a compacted worker would strand its task. `reassign` returns a task to todo without an assignee and retains report history, so the next briefing carries the prior worker's findings into the fresh window.

**Goals instead of a board.** Same-session goal rounds drive one objective and cannot express a dependency graph, per-task status, worker assignment, or multi-window reporting. The board is a separate event-sourced domain rather than an extension of goals.

## Consequences

- **Deterministic scheduling owns concurrency.** In serial mode a ready task waits while another runs; the driver's per-agent serialized pass and the competing-turn fence prevent double-spawning.
- **Composition is opt-in and source-independent.** Installing `dsh-conductor-bundle` adds one profile row whose dependency closure supplies the service, driver, tools, and managed user preset; the base bundle and official source tree carry none of them. Uninstall removes the Host row but leaves the marker-owned preset until an uninstall lifecycle exists.
- **The board is per-conductor-session.** Forking the conductor session carries the board; there is no cross-session export. A clear is a durable tombstone.
- **Cold worker delivery needs the direct-parent relationship.** After a handover only the retiring window's durable children cold-resume; the successor waits for the worker to be live or reassigns it.
- **Compaction counts drive both handovers.** The driver hands over at `handoverAfterCompactions`; worker reports carry the worker's compaction count for the conductor to judge reassignment.
- **The fold validates the whole task graph.** `decodeConductorChange` checks exact key sets, dependency resolvability and acyclicity, revision/timestamp monotonicity, per-operation field-touch rules, and report-history suffixes, so a violating stream fails loud wherever the invariant companion is installed.

## Testing

The four packages carry 136 tests across service, tools, driver, fold, projection, and invariant suites, with 100% per-file coverage. The driver tests run a real AgentLoop with scripted model responses and a fake subagent service, covering serial and parallel cadence, blocked and complete board transitions, spawn/checkpoint/block/complete failures, automatic handover on compaction, and teardown. The strict fold is exercised table-driven through the invariant companion, and a real-composition loader smoke covers the persisted board in a headless process (fixture under `examples/headless-agent/tests/fixtures/conductor-domain/`). A source-independence smoke starts the exact official `origin/master` commit `47f9438` from a clean worktree with an isolated DSH home whose profile declares only the deployed bundle: the composed tree adds one `conductor-bundle` row, Web returns HTTP 200, and the official preset picker discovers the bundle-managed conductor preset. The smoke deliberately observes no built-in hero scheduling selector, documenting that UI override as outside the additive plugin boundary rather than borrowing it from the feature checkout.

## Deferred

- **Remote providers** do not participate in the board; windows are in-process continuable subagents.
- **Built-in client presentation is outside the additive bundle boundary.** `task_board` is the board view; exact hero controls, conversation bubble overrides, workspace row behavior, and settings-shell layout require extension points in their owning built-in client plugins.
- **Worker-side automatic handover** (self-fork on compaction) is not implemented; the conductor reassigns instead.
