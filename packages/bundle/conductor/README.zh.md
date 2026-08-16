# `@deepseek-ai/dsh-conductor-bundle`

[English](README.md) | 中文

指挥家模式的可安装 profile 层。[`cordis.patch.yml`](cordis.patch.yml) 把本包作为一个 Host 行挂载；该行挂载事件溯源的 [`dsh-conductor`](../../conductor/conductor/README.md) 服务与自动 [`dsh-conductor-round-driver`](../../conductor/conductor-round-driver/README.md)，向运行中的 Harness 注册插件事件词汇，并在用户的 DSH home 下生成一个受管理的 `conductor` preset。该 preset 通过本包的子路径导出解析 [`dsh-tool-conductor`](../../conductor/tool-conductor/README.md) 与 [`dsh-tool-task-report`](../../conductor/tool-task-report/README.md)，因此 profile 只需把本 Bundle 加为直接依赖。

使用 `dsh plugin --profile web add @deepseek-ai/dsh-conductor-bundle` 把本包装入 Web profile；源码 checkout 可以传入打包或部署后的包目录。若用户已经独立创建了同名且不受本包管理的 preset，Bundle 会拒绝覆盖。

## 模型体验

通过受管理 preset 的指挥家 persona 与两个模型面工具包影响模型。Host 服务与轮次驱动本身不贡献提示词文本。

#### KV Cache 影响

无直接影响；提示词与请求影响由指挥家服务和工具包各自负责。

## 已知限制与暂缓事项

- **卸载后受管理 preset 暂时保留**——移除 profile 依赖会移除 Host 运行时，但 Bundle 没有可在包卸载时删除 `${DSH_HOME}/.agent-presets/conductor` 的生命周期；以后重新安装会通过标记文件安全刷新它。
- **通用 Web 展示留在其所属插件**——首页精确位置的串并行选择器、跨会话消息气泡、subagent 工作区行与设置外壳布局都需要其内置客户端插件提供内部扩展点；在未修改的官方 checkout 上，纯增量 Bundle 不会提供这些 UI 改动。
