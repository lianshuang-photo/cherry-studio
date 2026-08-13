# DeepSeek Harness 运行时（Cherry 内）

第三个智能体会话运行时，类型为 `dsh`。它直接组合固定版本的
[`@deepseek-ai/dsh-*`](https://github.com/deepseek-ai/deepseek-harness)
npm 包，在 Electron 主进程内运行；**不需要 Python、`deepseek-harness-sdk`、
`DSH_PYTHON` 或 DSH 子进程**。

## 范围

DSH 在 Cherry 中是一个 Pi 级别的 Agent Runtime，而不是嵌入完整 DSH 产品：

- Cherry 模型、系统提示词、工作区指令、会话恢复、压缩、用量和原生 steering
- DSH 原生文件、Bash、Todo、Plan mode 和同步子 Agent
- Cherry 的审批、禁用工具和四种权限模式
- Cherry MCP 桥：用户 MCP、内置/知识库、memory、Skills，以及满足条件的 Assistant 工具
- 只加载当前 Cherry Agent 显式启用的 Skills；不会扫描工作区、`DSH_HOME` 或用户目录中的 DSH Skills

不包含 `dsh plugin add`、任意 npm 插件、`cordis.yml` patch、HMR、DSH Web UI、后台 jobs/workflow 或 fork。

## 本机开发

1. 使用 `package.json` 锁定范围内的 Node（当前为 `>=24.11.1 <24.16.0`），然后运行 `pnpm install`。
2. 主进程有修改时需重启 Electron。为避免污染日常数据，推荐：

   ```sh
   CS_DEV_USER_DATA_SUFFIX=DshE2E pnpm debug
   ```

3. 在资源库创建一个运行模式为 **DeepSeek Harness** 的 Agent，配置 Cherry 提供方和模型，选择工作区后开始会话。

密钥只保存在 Cherry 提供方配置中，禁止放入 `.env`、命令行或仓库文件。

## 最小验收

在空临时工作区创建 DSH Agent，默认权限下发送“只回复 OK；不得调用工具、不得读写文件或网络”。确认获得文本回复后，正常退出 Electron。这个验证会在隔离用户目录写入提供方、Agent、会话和 DSH 会话状态，也会产生模型请求日志/费用；它不是零写操作。

可通过 Electron CDP 的 agent-browser 做界面自动化：

```sh
agent-browser connect 9222
```

## 已知边界

- MCP 工具集在连接时取快照：启动前会预热用户 MCP 目录，随后工具配置变更会触发运行时重建。
- DSH 用固定的 Cherry 插件组合；第三方 DSH 插件不会获得 Electron 主进程权限。
- `getSupportedCommands()`、`stopTask()` 和后台任务接口保持未实现，符合 Pi 级首期范围。
