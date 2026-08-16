# dsh-tool-conductor

Model-facing conductor tools: board init, task decomposition, status tracking, scheduling, worker messaging, and role handover over the persisted conductor domain. The tools are mounted by an agent preset (the shipped `conductor` preset mounts them); worker windows inherit the same preset, but the conductor service restricts these tools away from them at child creation.

## Tools

- `conductor_init` — create the board for a user-described objective; the calling top-level session becomes the conductor. Omit `mode` to use the saved user preference (`parallel` until changed); pass it only for an explicit per-board override. The plan outline is stored on the board.
- `task_board` — read the full board view (objective, plan, mode, tasks with status/dependencies/assignee/reports, activation, compaction count).
- `task_create` — add tasks with `depends_on` referencing existing task ids; the dependency graph must stay acyclic.
- `task_update` — `start` / `done` / `blocked` (reason required) / `unblock` / `reassign` (fresh worker window, prior reports retained).
- `conductor_update` — `edit` (objective/plan), `set_mode` (serial/parallel and cap), `pause` / `resume` / `complete` / `block` (reason required).
- `task_schedule` — force one scheduling pass; the round driver also schedules automatically at conductor quiescence.
- `conductor_message` — deliver one message to an assigned worker window (cold-resumes direct children).
- `conductor_handover` — hand the role to a fresh window with a full board transfer.

## Guidance section

The `tool:conductor` prompt section renders the conductor protocol (decompose → track → re-plan → escalate to the user → reassign compacted workers → hand over when compacted) only where the conductor tools are visible; worker windows with the tools restricted away see an empty section.

## Config

| Field | Default | Meaning |
|---|---|---|
| `workerHandoverAfterCompactions` | `4` | Worker compaction count at which the guidance tells the conductor to reassign the task |

## Model Experience

Every tool returns the compact board JSON (or the spawned/delivered identities), so the model re-reads one stable shape. All mutations are compare-and-set against the latest revision returned by the previous call.

#### KV Cache effect

The tool catalog is fixed per composition; each mutation's result text varies with the board state, shifting the derivation from the appended tool result onward.

## Known Limitations and Deferred Work

- **Scheduling is deterministic, not model-chosen** — the model cannot pick which ready task runs next; the board's mode and dependency order decide.
- **No board UI** — the board is model-visible through `task_board` only; no client widget renders it yet.
