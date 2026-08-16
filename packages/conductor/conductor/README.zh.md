# dsh-conductor

事件溯源的指挥家任务板领域与调度服务。**指挥家窗口**是持有任务板的会话：用户目标、实现方案大纲、调度模式、带依赖关系的任务图。指挥家把目标拆解为任务，工人窗口（continuable 子代理会话）执行任务，轮次驱动在指挥家空闲时自动推进工作。

## 服务：`ConductorService`（ctx 键：`conductor`）

任务板以事件溯源方式存储在指挥家会话自己的日志中（`conductor/change` 事件），与 goal 领域完全一致。所有变更都是 compare-and-set：每次调用携带当前 `ConductorRef`，过期修订被拒绝。任务板在重启与 fork 后依然存在，每个会话的日志是其任务板状态的唯一事实来源。

### 角色与窗口

- **指挥家**：创建任务板的会话（`board.conductorSessionId`）。只有顶层会话（无委托深度、非 subagent 来源）可以调用 `init`；工人不能成为指挥家。指挥家专用操作对其他调用者一律以 `CONDUCTOR_NOT_CONDUCTOR` 拒绝。
- **工人**：由 `spawnWorkers` 创建、带自包含任务简报的 continuable 子代理。子会话加入指挥家的 agent preset；服务通过 `workerToolFilter` 把指挥家专用工具从工人窗口剔除，并安装工人 persona。工人通过 `report` 上报，服务校验调用者是该任务 assignee 后把报告提交到**当前**指挥家的任务板，并把格式化消息投递给当前指挥家窗口。
- **继任窗口**：`handover` 创建全新的 continuable 子会话，把完整任务板快照写入其日志并退役当前窗口。同一个变更载荷同时提交到两个会话，双方都能重建相同的交接后任务板。工人报告通过血缘链路由，交接后仍会送达当前指挥家。

### 调度

`spawnWorkers` 先把依赖被阻塞的任务标记为 blocked，再按任务板模式为就绪任务创建工人：`serial` 每次只运行一个，`parallel` 最多运行 `maxParallelWorkers` 个。轮次驱动在任务板 active 且 armed、指挥家代理空闲时自动调用它；无事可做时完成或阻塞任务板，并唤醒指挥家窗口向用户汇报。被压缩过多的指挥家窗口由驱动自动交接给新窗口（`handoverAfterCompactions`，驱动配置）。

### 激活

与 goal 领域一样，续行资格是进程局部的（`armed`/`disarmed`）。与 goal 不同：作为 active 任务板当前指挥家恢复的会话会自动重新 armed——用户最初的目标就是持续推进的常驻授权，直到用户主动停止。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `workerProvider` | `spawn` | 创建工人窗口的 provider 名 |
| `handoverProvider` | `spawn` | 创建继任指挥家窗口的 provider 名 |
| `workerPersona` | 内置工人 persona | 覆盖工人窗口内部署 persona 的 persona |
| `workerToolFilter` | 剔除八个指挥家专用工具 | 应用到工人窗口的工具过滤 |
| `maxParallelWorkers` | `3` | init 未指定时使用的并行上限 |
| `reportHistoryLimit` | `8` | 每个任务保留的报告条目上限 |

## 设置

服务注册 `conductor` 设置命名空间（当组合了 settings provider 时）：`mode`（`serial` 或 `parallel`，默认 `parallel`）是用户预设的调度模式，init 请求未指定模式时采用。init 请求中显式的 `mode` 始终优先于设置；未组合 settings provider 的组合回退到同样的 `parallel` 默认值。

## 事件

- `conductor/change` — 持久化任务板变更（完整快照或 clear 墓碑）。交接时同一载荷追加到两个会话。
- `conductor/changed` — 提交后触发的作用域代理事件，轮次驱动据此推进。
- 消息源 `conductor`、`conductor-report`、`conductor-driver` 用于窗口间消息归因。

## 模型体验

任务板视图（`task_board`）携带目标、方案大纲、模式、每个任务的状态/依赖/assignee/报告历史、当前激活状态与窗口压缩次数。工人简报与交接简报是根据任务板状态生成的确定性文本，任何提示词都能从日志重建。

#### KV 缓存影响

任务板变更会追加新会话事件并因此产生新的派生消息；指挥家不行动时请求前缀稳定，每次变更都会使追加点之后的派生发生变化。

## 已知限制与后续工作

- **仅进程内窗口** — 工人与继任指挥家都是进程内 continuable 子代理；远程 provider 不参与任务板。
- **退役窗口只读** — 交接后旧会话的任务板保留历史，但其变更会被拒绝、驱动停止；深层历史仍在日志中。
- **工人交接由指挥家驱动** — 压缩过多的工人由指挥家的 `reassign` 替换，前序报告保留在下一份简报中；没有自动的工人侧 fork。
- **冷启动工人投递依赖直接父关系** — 交接后只有退役窗口的持久子会话可以冷恢复；继任者需等待工人上线或重新指派。
- **任务板按指挥家会话隔离** — 没有跨会话任务板导出；fork 指挥家会话会携带任务板，clear 是持久化墓碑。
