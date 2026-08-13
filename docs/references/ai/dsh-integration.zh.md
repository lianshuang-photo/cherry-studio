# Cherry Studio × DeepSeek Harness 集成方案

Pi 已于 2026-08-13 合入 Cherry `main`
（[#16630](https://github.com/CherryHQ/cherry-studio/pull/16630)）。
同一天 DeepSeek 公开了官方 harness
（[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，
npm `@deepseek-ai/dsh@0.1.0-rc.6`）。

本文是第三个智能体类型 `'dsh'` 的落地计划。

请先读官方中文文档：

- [使用 Web UI](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/index.zh.md)
- [配置模型](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.zh.md)
- [Python SDK 快速上手](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/python-sdk.zh.md)
- [dsh 命令行](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.zh.md)

## 官方上手对应 Cherry 的两个座位

官方指南是 **先 Web UI，后 SDK**：

1. `dsh web`（启动目录是默认文件系统根；没选工作区前，输入框锁住）
2. **设置 → 模型**：DeepSeek 密钥只写一次，存在 `$DSH_HOME/.credentials.yaml`；设置页只留引用。下次请求即生效，不用重启。
3. **选择工作区**
4. 发一轮。智能体读改文件、跑命令、委派、维护计划；当前权限策略要求审批时会先问。

这对应 Cherry 里已有的两个面，不要捏成一个：

| 官方表面 | Cherry 里最接近的座位 | 什么时候用 |
|---|---|---|
| `dsh web` | 代码工具 / 内嵌浏览器页 | 原样上官方界面。最快，不用做事件映射。 |
| `dsh --profile headless` | 一次性任务 / 定时任务 | 定时或 IM 里跑完就退。 |
| Python / TS 的 JSON-RPC SDK | 智能体会话驱动（Pi / Claude Code 那个槽） | 要 Cherry 原生会话、审批、恢复、逐字稿。 |

不要一上来就把整棵 Cordis 树 `import` 进主进程。官方的程序化替代方案已经是 SDK：隔离的工作目录 + 会话目录 + 会话 id。复用同一个会话 id 会保留持久 Bash（工作目录、已导出变量、函数）。新 id 就是新对话。

## 该抄 Pi 的，和不该抄的

Cherry 的宿主已经按驱动中立写好了：

- `AgentSessionRuntimeService` 按 `agent.type` 分发
- 渲染进程读 `AGENT_RUNTIME_CAPABILITIES[agent.type]`
- 加一个运行时 = **一条能力描述 + 一个主进程驱动包**

见 Cherry `main` 上的 `docs/references/ai/adding-a-runtime.md`。

Pi 是 **进程内 SDK**（`@earendil-works/pi-coding-agent` 的 `createAgentSession`）。
DeepSeek Harness 是 **Cordis 插件树**。没有对等的单函数可以 `import()` 进 Electron 主进程。最接近的一等 API 是 JSON-RPC SDK：

| 表面 | 包 | 作用 |
|---|---|---|
| 命令行 / Web UI | `@deepseek-ai/dsh` | `dsh web`，`dsh --profile headless "任务"` |
| 无界面一次性 | `@deepseek-ai/dsh-headless` | 打印最后一条助手文本后退出 |
| TypeScript 客户端 | `@deepseek-ai/dsh-sdk-client` | `DeepSeekHarness.run()` |
| JSON-RPC 运行时 | `@deepseek-ai/dsh-sdk-jsonrpc-demo` | 客户端拉起的标准输入输出对端 |
| Python 客户端 + 内置可执行文件 | `deepseek-harness-sdk` | 本 demo 用的这条 |

**第一版应对齐 Claude Code（子进程），而不是 Pi（进程内）。**

Pi 做成进程内，是为了注入用户自己的厂商/密钥，并复用 Cherry 的工具审批表。
若要对 dsh 做同样的事，Cherry 必须自己当 Cordis 宿主：挂上 `dsh-base`，用 Cherry 适配器换掉 `dsh-llm-deepseek`，用 Cherry 插件换掉审批。那是第二阶段，不是周末能抄完的端口。

## 建议的第一版形状

```
渲染进程  →  AgentSessionRuntimeService
                 │
                 ▼
           DshRuntimeDriver.connect()
                 │
                 ▼
           DshRuntimeConnection
                 │  session.event / session.status
                 ▼
           dshStreamAdapter  →  AgentRuntimeEvent
                 │
                 ▼
        DeepSeekHarness（SDK 子进程）
                 │
                 ▼
        dsh-jsonrpc-agent + cordis.yml
```

### 能力描述

```ts
dsh: {
  permissionModes: ['default', 'plan', 'acceptEdits', 'bypassPermissions'],
  modelTiers: false,          // 和 Pi 一样，一场会话一个模型
  heartbeat: false,
  knowledgeBases: true,       // 以后走 MCP 桥
  mcp: true,                  // 已有 dsh-mcp-client
  skills: true,               // dsh-skill / 显式技能路径
  transport: 'dsh-agent',
  createDefaults: { permissionMode: 'acceptEdits' }
}
```

dsh 自带 **计划模式** 和 **子智能体**。Pi 没有。驱动还没真正接上 `dsh-plan-mode` 之前，不要在描述里列出 `plan`。

### 事件对照

dsh 的真相源是会话日志，不是聊天数组。

| dsh 会话事件 | Cherry 运行时事件 |
|---|---|
| `turn/start` | 打开宿主这一轮 |
| `assistant/chunk` 的 `text-delta` | `chunk` 正文增量 |
| `assistant/chunk` 的 `reasoning-delta` | `chunk` 推理增量 |
| `assistant/chunk` 的 `usage` | `context-usage` |
| `tool/call` | 工具入参开始 + 入参就绪 |
| `tool/result` | 工具输出就绪 / 工具输出错误 |
| `compaction/start` `compaction/end` | 压缩开始 / 压缩完成 |
| `llm/retry` | `api-retry` |
| `approval/asked` | 走工具审批表（改配置类一律拒绝） |
| `turn/end` | `turn-complete`（必须发，否则界面这一轮会挂住） |
| 会话 id | `resume-token` |

**保留 dsh 自己的工具名。** Pi 已经踩过坑：改成 Claude 的名字会搞坏禁用列表和审批查找。

### 凭据

官方 Web UI 把 DeepSeek 密钥只写进 `$DSH_HOME/.credentials.yaml`；设置页只留引用，从不回传明文（见「配置模型」）。
Cherry **不能**和用户自己的 `dsh web` 共用这份文件。

密钥不要写进 `cordis.yml`。适配器也认 `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL`（Python 教程用后者指向 OpenAI 兼容代理）。
只注入给子进程——和 Pi 的内存密钥仓是同一个意思。

给子进程单独的 `DSH_HOME`。默认 SDK 组合否则会去扫 `$HOME/.agents/skills`，第一轮就把用户家里所有技能倒进上下文。

恢复令牌是 **会话 id**，在 `{userData}/Data/Agents/.dsh/sessions` 下解析。不要持久化绝对路径。

### 资源信任

捆绑的 SDK 运行时会去扫 `$HOME/.agents/skills`（本 demo 第一轮就倒出过整套飞书技能）。要隔离 `DSH_HOME`，并关掉磁盘技能自动发现。对齐 Pi 的「默认拒绝」：

- 工作区 **文本**（如 `AGENTS.md`）可以加载，因为是用户亲手选的目录
- 工作区里的 **可执行插件** 在 Cherry 有明确信任界面之前，不要自动加载
- 托管技能用显式路径传入，不要目录遍历

### 轮次中途改方向

已发布的 SDK **没有** 取消当前提示 / 中途转向的接口。不要实现 `redirect()`。
宿主会把后续消息排到下一轮。原生转向（`agent.inject` / 收件箱拼接）等协议补了再说。

### 无界面 / IM 通道

Pi 有过一个洞：通道触发的无界面轮次可以不经确认改配置。
dsh 第一版在非交互轮次里必须拒绝 Cherry 的配置 / 加通道 / 重命名类工具。沿用同一套「必须审批」名单。

## 要在 Cherry 里加的文件

```
src/shared/data/types/agent.ts                 增加 'dsh'
src/shared/data/api/schemas/agents.ts          枚举加上
src/shared/ai/agentRuntimeCapabilities.ts      加上能力描述
src/shared/ai/dshBuiltinTools.ts
src/main/ai/runtime/dsh/DshRuntimeDriver.ts
src/main/ai/runtime/dsh/DshRuntimeConnection.ts
src/main/ai/runtime/dsh/dshStreamAdapter.ts
src/main/ai/runtime/dsh/dshSdk.ts              动态导入 / 拉起子进程
src/main/ai/runtime/registerDrivers.ts         register(new DshRuntimeDriver())
src/main/core/paths/...                        feature.agents.dsh.*
src/renderer/i18n/locales/{en-us,zh-cn,zh-tw}  文案
```

能力描述写全的话，渲染进程通常不用改。工具卡片先走通用卡，直到有人为 `transport === 'dsh-agent'` 写专用卡。

## 第二阶段（可选，进程内）

只有 Cherry 想像 Pi 那样自己掌管模型适配器时才做：

1. 用 `@deepseek-ai/dsh-app-boot` 启动 `dsh-base`
2. 注册一个 Cherry 的 `ctx.llm` 适配器，走现有厂商栈
3. 监听 `tools/pre-execute`，复用工具审批表
4. 把 `buildAgentMcpServers()` 桥成 `ctx.tools` 条目，不要再开一个 MCP 客户端
5. 把 `buildAgentRuntimePrompt()` 映射进 `ctx.systemPrompt` 各段

在此之前一直走 SDK。官方 Python 包已经带了单文件运行时（`deepseek-harness-runtime-bin`）；TypeScript 客户端仍要显式给出启动命令和参数。

## 验收（和 Pi 同一张清单）

- 能创建一个 `dsh` 智能体；选择器显示「DeepSeek Harness」
- 打开会话，改一个文件，出现审批
- 轮次中途的跟进消息会排队（没有原生转向）
- 重启应用后，恢复令牌仍打开同一个会话 id
- IM / 无界面轮次不能调用 Cherry 配置类工具
