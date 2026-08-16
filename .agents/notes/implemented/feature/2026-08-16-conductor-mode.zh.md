# Agent Note：指挥家模式——多窗口任务编排

Status: implemented

中文 | [English](2026-08-16-conductor-mode.md)

## 问题

单一 agent 会话在长期目标中会逐渐劣化：上下文反复压缩、一个窗口承担所有决策、并行工作要么是脚本化（workflow）要么对用户不可见（临时 subagent）。用户需要一种一等模式：一个指挥家会话把目标拆解为子任务、追踪进度、按串行或并行调度工人窗口、接收完成与卡点上报，并在压缩过多后把职责交接给新窗口——所有窗口保持消息驱动，指挥家是面向用户的唯一渠道。

## 决策

指挥家模式以一个能力 seam、一个可安装 profile Bundle 加一个 agent preset 交付。任务板在指挥家会话日志中事件溯源（`conductor/change`，与 goal 领域相同的全量快照 compare-and-set 纪律），轮次驱动在指挥家空闲时推进工作，工人与继任窗口都是进程内 continuable 子代理。

**平面划分与可移植安装。** `dsh-conductor`（服务）与 `dsh-conductor-round-driver` 通过一个 `dsh-conductor-bundle` 行挂在 Host 平面：服务发布 `ctx.conductor`，preset 行发布它会撞进根 realm。Bundle 携带模型面工具（`dsh-tool-conductor`、`dsh-tool-task-report`）的依赖闭包，并把打包的 `conductor` 组合生成到 `${DSH_HOME}/.agent-presets/conductor`；工具行通过 Bundle 子路径导出解析，所以 profile 只有 Bundle 一个直接依赖。工人子会话通过普通的 `composeFrom` 绑定加入该 preset；服务用 `workerToolFilter` 剔除八个指挥家专用工具并安装工人 persona，一个 preset 靠工具注册表区分两种角色。由于官方 build 无法静态收录树外插件事件，Bundle 激活时还会在任何指挥家会话打开前向进程局部的已知事件集合注册 `conductor/change`。

**任务板与角色。** 只有顶层会话（无委托深度、非 subagent 来源）可以 `init`；任务板记录 `conductorSessionId`。变更要求调用者是当前指挥家；退役窗口保留历史但拒绝变更。工人通过 `report` 上报：服务校验调用者是任务 assignee，把报告提交到**当前**指挥家的任务板（受 `reportHistoryLimit` 约束），记录工人压缩次数，并投递唤醒指挥家窗口的格式化消息。

**调度。** 依赖全部完成的任务即为就绪任务。`spawnWorkers` 先把依赖被阻塞的任务标记为 blocked，再按模式创建工人：`serial` 每次一个，`parallel` 最多 `maxParallelWorkers` 个。驱动在任务板 active 且 armed、指挥家代理空闲时自动调用；无事可做时完成任务板（全部完成）或阻塞它（`blocked-tasks`）并唤醒指挥家向用户升级。创建工人失败会阻塞任务板（`spawn-failed`），避免无限重试。

**交接。** 压缩次数达到 `handoverAfterCompactions` 的指挥家窗口会被交接：全新 continuable 子会话收到完整任务板快照与确定性简报，同一变更载荷提交到两个会话，双方重建相同的交接后任务板。工人报告沿血缘链路由，交接后仍送达当前指挥家。工人侧交接由指挥家驱动：报告显示压缩过多的工人被 `reassign`，前序报告保留在下一份简报中。

**激活与节奏。** 续行资格与 goal 一样是进程局部的（`armed`/`disarmed`），但以 active 任务板当前指挥家身份恢复的会话会自动重新 armed：用户最初的目标就是持续推进的常驻授权，直到用户主动停止。所有推进都是消息驱动的——驱动在空闲时行动，报告唤醒窗口，任何窗口都不轮询。

## 备选方案

**Fork 播种式交接。** 初版设计通过 fork 指挥家会话交接，继承被压缩的上下文及其压缩事件。继任者的上下文与退役窗口逐字节相同——这正是交接要解决的质量问题。交付版本创建全新（无种子）子会话，携带完整任务板快照与自包含简报，新窗口以干净上下文与完整状态转移开局。血缘链路由随后把报告路由到当前指挥家，继任者不继承任何持久父关系。

**模型驱动调度。** 让指挥家模型每轮调用调度工具能保持模型掌控，但消耗 token 且依赖模型记得推进。驱动使调度确定性化（依赖 + 模式可计算），把模型的角色限定为拆解、报告分诊与用户升级。`task_schedule` 工具保留用于显式强制。

**每任务单工人、不支持再指派。** 工人最初是一次性的；被压缩的工人会搁浅其任务。`reassign` 把任务退回 todo 且清除 assignee、保留报告历史，下一份简报把前序工人的发现带进新窗口。

**用 goal 代替任务板。** 同会话 goal 轮次驱动一个目标，无法表达依赖图、任务级状态、工人指派或多窗口上报。任务板是独立的事件溯源领域，而不是 goal 的扩展。

## 后果

- **确定性调度拥有并发。** 串行模式下就绪任务等待其他任务完成；驱动按代理串行化推进与竞争回合围栏防止双重创建。
- **组合可选且与源码无关。** 安装 `dsh-conductor-bundle` 会加入一个 profile 行，其依赖闭包提供服务、驱动、工具与受管理的用户 preset；base Bundle 与官方源码树都不包含它们。卸载会移除 Host 行，但在具备卸载生命周期前会保留由标记文件持有的 preset。
- **任务板按指挥家会话隔离。** fork 指挥家会话会携带任务板；没有跨会话导出。clear 是持久化墓碑。
- **冷工人投递依赖直接父关系。** 交接后只有退役窗口的持久子会话可以冷恢复；继任者等待工人上线或重新指派。
- **压缩次数驱动两侧交接。** 驱动在 `handoverAfterCompactions` 时交接；工人报告携带工人压缩次数供指挥家判断是否再指派。
- **fold 校验整个任务图。** `decodeConductorChange` 检查精确键集、依赖可解析性与无环性、修订/时间戳单调性、按操作字段触及规则与报告历史后缀，违规流在安装 invariant 伴生插件处大声失败。

## 测试

四个包共有 136 个测试，覆盖服务、工具、驱动、fold、projection 与 invariant 套件，按文件覆盖率 100%。驱动测试运行真实 AgentLoop、脚本化模型响应与假 subagent 服务，覆盖串行/并行节奏、阻塞与完成转换、创建/检查点/完成/阻塞失败、压缩自动交接与拆卸。严格 fold 通过 invariant 伴生插件表驱动验证，另有真实组合 loader 冒烟测试覆盖 headless 进程中的持久化任务板（fixture 位于 `examples/headless-agent/tests/fixtures/conductor-domain/`）。源码独立性冒烟测试从干净 worktree 启动精确的官方 `origin/master` 提交 `47f9438`，使用隔离 DSH home 且 profile 只声明部署后的 Bundle：组合树只增加一个 `conductor-bundle` 行，Web 返回 HTTP 200，官方 preset 选择器能发现 Bundle 管理的指挥家 preset。该测试刻意观察到内置首页没有串并行选择器，用以记录这个 UI 覆盖位于增量插件边界之外，而不是从功能 checkout 借入它。

## 延后

- **远程 provider** 不参与任务板；窗口是进程内 continuable 子代理。
- **内置客户端展示不在增量 Bundle 边界内。** `task_board` 是任务板视图；首页精确位置的控件、会话气泡覆盖、工作区行行为与设置外壳布局需要其所属内置客户端插件提供扩展点。
- **工人侧自动交接**（压缩时自 fork）未实现；由指挥家再指派替代。
