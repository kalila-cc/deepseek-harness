# dsh-tool-task-report

The worker-scoped `task_report` tool: structured completion, blocker, and progress reporting from an assigned worker window into the current conductor's board, delivered to the conductor window. Mounted by the `conductor` agent preset; the conductor service's authority rules admit only the reported task's assignee.

## Tool: `task_report`

Call with `task_id` (from the worker briefing), `status` (`progress` | `done` | `blocked`), and a self-contained `message`. The service validates the caller against the task's assignee, commits the report into the current conductor's board (bounded history), records the worker's compaction count, and delivers a framed report message that wakes the conductor window. Reporting does not end the worker's turn.

## Model Experience

The tool returns the accepted message id; the conductor sees the framed report as its next turn. Worker briefings instruct exactly when to report, so the tool needs no separate prompt section.

#### KV Cache effect

The single tool has no state; each call appends one report to the board and one delivered message to the conductor.

## Known Limitations and Deferred Work

- **Reports cannot be retracted** — the durable report history is append-only; corrections arrive as new reports.
- **No worker-side board reads** — a worker sees only its briefing; the conductor owns the full picture.
