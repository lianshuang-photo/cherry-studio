# DeepSeek Harness 运行时（Cherry 内）

第三个智能体会话运行时，类型为 `dsh`。对照 Pi 的接入清单落地，用官方 Python SDK 子进程驱动 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

设计过程见 [集成方案](./dsh-integration.zh.md)。

## 换机接着做

1. 拉这个分支：`feat/dsh-agent-runtime`（推在 `lianshuang-photo/cherry-studio`，不要推官方 `CherryHQ/cherry-studio`）。
2. `pnpm install` 后用 Dev 配置启动。主进程改动要重启 Electron，HMR 不够。
3. 安装官方 SDK：`python3 -m pip install deepseek-harness-sdk`，或 `export DSH_PYTHON=/path/to/venv/bin/python`。
4. 密钥只走 Cherry 提供方配置。自定义 OpenAI 兼容网关会补 `/v1`，模型 id 保留网关目录名（例如 `agent/deepseek-v4-flash`）。

已经修过：网关 404（少 `/v1` / 剥掉了 `agent/`）、工具结果对不上 `message.source.callId`、过早把 Cherry 轮次结束在 dsh 的第一次 `turn/end`、打包行 `text-chunks` / `reasoning-chunks` 没解开。最后一轮界面验收被打断，换机后建议新建一个 DSH 会话发短消息再验。

## 本机怎么跑

1. 安装官方 SDK（只需一次）：

```sh
python3 -m pip install deepseek-harness-sdk
# 或指定解释器：export DSH_PYTHON=/path/to/python
```

2. 在这个工作树启动 Cherry：

```sh
cd /Users/leobao/orca/workspaces/cherry-studio/dsh-runtime
pnpm install
pnpm dev
```

3. 资源库 → 新建智能体 → **运行模式** 选 **DeepSeek Harness**。
4. 模型选 DeepSeek（或 OpenAI 兼容网关）。密钥走 Cherry 自己的提供方配置，不要写进 `.env` 的 `DSH_MODEL`。
   自定义网关会按 Cherry 对话同样的规则补上 `/v1`，并使用网关目录里的模型 id（例如 `agent/deepseek-v4-flash`）。
5. 选一个工作区目录，打开会话，发消息。文件读写和 bash 由 dsh 内置工具执行。

## 行为边界（第一版）

- 恢复令牌是会话 id，状态在 `{userData}/Data/Agents/.dsh/sessions`
- 子进程有独立 `DSH_HOME`，不会去扫你家里的 `~/.agents/skills`
- 没有中途转向：跟进消息会排到下一轮
- 尚未接入 Cherry MCP / 托管技能 / 计划模式（描述里也没勾）
- 缺 SDK 或缺密钥时，`validateSession` 会直接报错，不会默默失败

过程文档：[集成方案](./dsh-integration.zh.md)。
