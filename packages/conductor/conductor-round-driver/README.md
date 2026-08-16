# dsh-conductor-round-driver

Automatic advancement driver for conductor task boards: at conductor quiescence it hands the role over after too many compactions, spawns workers for ready tasks per the board mode, and completes or blocks the board when nothing can proceed — then wakes the conductor window to report to the user. Host-plane like the goal round driver; the `conductor` agent preset contributes the model-facing tools.

## Behavior

The driver listens for `conductor/changed`, agent status transitions, and inbox insertions, and runs one serialized pass whenever the current conductor agent is idle and its board is active and armed:

1. A conductor window whose compaction count reaches `handoverAfterCompactions` is handed over to a fresh window; the retiring window is woken to announce it.
2. `spawnWorkers` marks dependency-blocked tasks and spawns workers for the ready set per the board mode. A spawn failure blocks the board (`spawn-failed`) so the pass cannot retry forever.
3. With nothing spawned: in-progress work means wait; every task done means the board completes; a blocked task means the board blocks (`blocked-tasks`) and the conductor is woken to escalate to the user.

Every failure path is logged and contained: a failing checkpoint, completion, or block leaves the board state unchanged, and a rejected driver task retires without corrupting the next trigger.

## Config

| Field | Default | Meaning |
|---|---|---|
| `handoverAfterCompactions` | `4` | Compaction count at which the driver hands the conductor role to a fresh window |

## Model Experience

The driver adds no prompt text. Its notices arrive as `conductor-driver` user messages (`form: 'notice'`), telling the conductor to summarize completed work for the user, escalate a blocked board, or announce a handover.

#### KV Cache effect

None beyond the delivered notices: the driver composes no request prefix of its own.

## Known Limitations and Deferred Work

- **Quiescence-gated** — the driver acts only while the conductor agent is idle, so a conductor mid-turn is never interrupted.
- **Worker progress is not driven** — workers run to their own reports; the driver only schedules fresh work and terminal states.
