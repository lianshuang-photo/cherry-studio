# Cherry Studio × DeepSeek Harness 集成

本文说明已落地的 DSH 运行时集成。运行时概览和本机验收见
[DeepSeek Harness 运行时](./dsh-runtime.zh.md)。

## 架构

Cherry 将 DeepSeek Harness 作为第三个 Agent Session Runtime，而不是嵌入
DSH Web 产品。`DshRuntimeDriver` 为每个 Cherry Agent Session 创建一个隔离的
进程内 Cordis 组合：固定版本的 `@deepseek-ai/dsh-*` npm 包和 Cherry 自有桥接
共同运行在 Electron 主进程。

```text
Renderer
  → AgentSessionRuntimeService
    → DshRuntimeDriver / DshRuntimeConnection
      → 固定 DSH Cordis 插件组合
        ├→ Cherry 模型与凭据桥
        ├→ Cherry 审批、禁用工具和权限桥
        ├→ Cherry MCP、知识库、memory、Skills 桥
        └→ DSH 文件、Bash、Todo、Plan、同步子 Agent
```

这不是 Python SDK 或 JSON-RPC 子进程集成：不需要安装
`deepseek-harness-sdk`、配置 `DSH_PYTHON`，也不会拉起 DSH runtime 子进程。
DSH 的 Bash 工具仍会按用户请求执行受权限策略约束的命令。

## Cherry 桥接

- 模型和密钥始终来自 Cherry provider 配置；密钥不写入 `cordis.yml`、`.env` 或
  DSH 凭据文件。
- Cherry 的系统提示词、工作区指令和显式启用的 Skills 被注入该会话。运行时关闭
  DSH 默认 Skills 目录和用户/工作区插件发现。
- 用户 MCP、内置 MCP、知识库、memory 和符合条件的 Assistant 工具通过进程内
  MCP bridge 注册为 DSH 工具；连接时工具目录会取快照。
- DSH 工具调用复用 Cherry 审批和禁用工具规则。`default`、`acceptEdits`、`plan`
  和 `bypassPermissions` 四种权限模式映射为 DSH 的 sandbox 与 approval 策略。

## 会话与事件

`DshRuntimeConnection` 将 DSH 会话事件转换为 Cherry 运行时事件，包含文本和推理
增量、工具调用/结果、压缩、用量、错误和轮次结束。Cherry 会话 id 同时作为 DSH
会话 id 和恢复令牌；DSH 持久化文件只存于 Cherry 的
`{userData}/Data/Agents/.dsh/sessions`，不会依赖用户已有的 DSH 会话目录。

运行中的会话支持原生 steering。MCP 配置更新会要求重建运行时，以重新取得工具
快照。

## 首期边界

首期目标是 Pi 级别完整 Runtime，不是开放 DSH 平台。不会开放给用户：

- `dsh plugin add`、任意 npm 插件、`cordis.yml` patch 或 HMR
- DSH Web UI
- 后台 jobs/workflow、fork 和其他后台任务接口
- 动态 slash commands、模型层级或 fast mode

`getSupportedCommands()`、`stopTask()` 和后台任务事件因此保持未实现。DSH 固定
插件组合不获得 Electron 主进程的任意扩展权限。

## 验收

在空临时工作区创建运行模式为 **DeepSeek Harness** 的 Agent，配置 Cherry provider
和模型，选择工作区后发送一轮请求。检查文本响应、工具审批和会话恢复；需验证 UI
时可使用 Electron CDP 的 agent-browser。完整开发环境和最小验收步骤见
[运行时文档](./dsh-runtime.zh.md)。
