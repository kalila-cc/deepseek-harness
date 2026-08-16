# `@deepseek-ai/dsh-conductor-bundle`

English | [中文](README.zh.md)

The installable profile layer for conductor mode. [`cordis.patch.yml`](cordis.patch.yml) mounts this package as one Host row; the row mounts the event-sourced [`dsh-conductor`](../../conductor/conductor/README.md) service and its automatic [`dsh-conductor-round-driver`](../../conductor/conductor-round-driver/README.md), registers the plugin event vocabulary with the running harness, and materializes a managed `conductor` preset under the user's DSH home. The preset resolves [`dsh-tool-conductor`](../../conductor/tool-conductor/README.md) and [`dsh-tool-task-report`](../../conductor/tool-task-report/README.md) through this package's subpath exports, so the profile adds only this bundle as a direct dependency.

Install this package into a Web profile with `dsh plugin --profile web add @deepseek-ai/dsh-conductor-bundle`. A source checkout may use a packed or deployed package directory. The bundle refuses to overwrite an existing unmanaged user preset with the same id.

## Model Experience

Through the managed preset's conductor persona and its two model-facing tool packages. The Host service and round driver themselves contribute no prompt text.

#### KV Cache effect

None directly; the conductor service and tool packages own their prompt and request effects.

## Known Limitations and Deferred Work

- **The managed preset currently remains after uninstall** — removing the profile dependency removes the Host runtime, but the bundle has no package-uninstall lifecycle in which to delete `${DSH_HOME}/.agent-presets/conductor`; a later reinstall safely refreshes it through the marker file.
- **Generic Web presentation stays in its owning plugins** — the exact hero scheduling selector, inter-session message bubbles, subagent workspace rows, and settings-shell layout require extension points inside their owning built-in client plugins. They are not supplied by an additive Bundle on an unmodified official checkout.
