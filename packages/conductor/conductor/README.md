# dsh-conductor

English | [中文](README.zh.md)

Event-sourced conductor task-board domain and scheduling service. A **conductor window** is one session that holds a task board: the user's objective, the implementation plan outline, the scheduling mode, and a dependency graph of tasks. The conductor decomposes the objective into tasks, worker windows (continuable subagent children) execute them, and the round driver advances the work automatically at conductor quiescence.

## Service: `ConductorService` (ctx key: `conductor`)

The board is event-sourced in the conductor session's own log (`conductor/change` events), exactly like the goal domain. Mutations are compare-and-set: every call takes the current `ConductorRef` and rejects a stale revision. The board survives restart and fork, and each session's log is the single source of truth for its board state.

### Roles and windows

- **Conductor**: the session that created the board (`board.conductorSessionId`). Only a top-level session (no delegation depth, not a subagent origin) may call `init`; workers cannot become conductors. Conductor-only operations reject any other caller with `CONDUCTOR_NOT_CONDUCTOR`.
- **Worker**: a continuable subagent child created by `spawnWorkers` with a self-contained briefing. The child joins the conductor's agent preset; the service restricts the conductor-only tools away from it (`workerToolFilter`) and installs the worker persona. A worker reports through `report`, which validates that the caller is the reported task's assignee, commits the report into the **current** conductor's board, and delivers the framed message to the current conductor window.
- **Successor window**: `handover` creates a fresh continuable child, transfers the full board snapshot into its log, and retires the caller. The same change payload commits to both sessions, so each side reconstructs the same post-handover board. Worker reports route through the lineage walk, so they keep landing on the current conductor after handovers.

### Scheduling

`spawnWorkers` marks tasks whose dependencies are blocked, then spawns workers for the ready tasks per the board mode: `serial` runs one worker at a time, `parallel` runs up to `maxParallelWorkers`. The round driver calls it automatically whenever the board is active and armed and the conductor agent is idle, and completes or blocks the board when nothing can proceed — then wakes the conductor window to report to the user. A conductor window that has been compacted too often is handed over to a fresh window by the driver (`handoverAfterCompactions`, driver config).

### Activation

Like the goal domain, continuation eligibility is process-local (`armed`/`disarmed`). Unlike goals, a session that resumes as the current conductor of an active board re-arms automatically: the user's original objective is the standing authorization to keep advancing until they stop it.

## Config

| Field | Default | Meaning |
|---|---|---|
| `workerProvider` | `spawn` | Provider name that establishes worker windows |
| `handoverProvider` | `spawn` | Provider name that establishes successor conductor windows |
| `workerPersona` | built-in worker persona | Persona shadowing the deployment persona inside worker windows |
| `workerToolFilter` | deny the eight conductor-only tools | Tool scoping applied to worker windows |
| `maxParallelWorkers` | `3` | Parallel cap used when an init request omits its own cap |
| `reportHistoryLimit` | `8` | Upper bound on report entries retained per task |

## Settings

The service registers the `conductor` settings namespace (when a settings provider is composed): `mode` (`serial` or `parallel`, default `parallel`) is the user-preferred scheduling mode that `init` applies when the init request names none. An explicit `mode` in the init request always wins over the setting, and compositions without a settings provider fall back to the same `parallel` default.

## Events

- `conductor/change` — durable board mutation (full snapshot, or clear tombstone). Same payload appends to both sessions during a handover.
- `conductor/changed` — scoped agent event after a committed mutation, observed by the round driver.
- Message sources `conductor`, `conductor-report`, and `conductor-driver` attribute delivered window-to-window messages.

## Model Experience

The board view (`task_board`) carries the objective, plan outline, mode, every task with its status/dependencies/assignee/report history, the current activation, and the window's compaction count. Worker briefings and handover briefings are deterministic text built from board state, so every prompt is reconstructable from the log.

#### KV Cache effect

Board state changes append new session events and therefore new derived messages; the request prefix is stable while the conductor does not act, and each mutation shifts the derivation from the append point onward.

## Known Limitations and Deferred Work

- **In-process windows only** — workers and successor conductors are continuable in-process subagents; remote providers do not participate in the board.
- **A retired window is read-only** — after a handover the old session's board keeps its history, but its mutations reject and its driver stops; deep history remains in its log.
- **Worker handover is conductor-driven** — a worker whose session compacts too often is replaced by the conductor's `reassign`, which keeps prior reports in the next briefing; there is no automatic worker-side fork.
- **Delivering to a cold worker requires the direct-parent relationship** — after a handover only the retiring window's durable children cold-resume; the successor must wait for the worker to be live or reassign it.
- **The board is per-conductor-session** — there is no cross-session board export; forking the conductor session carries the board, and a clear is a durable tombstone.
