import { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import * as AgentSpine from '@deepseek-ai/dsh-agent-spine-demo'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import * as FsObservationPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import PlanModeController from '@deepseek-ai/dsh-plan-mode'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as SessionCheckpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as InProcessSubagent from '@deepseek-ai/dsh-subagent-spawn-in-process'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as ToolAskUser from '@deepseek-ai/dsh-tool-ask-user'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { AgentPermissionMode } from '@shared/data/api/schemas/agents'

import { type DshInteractionBridgeContext, installDshInteractionBridge } from './DshInteractionBridge'
import { installDshModelBridge } from './dshModelBridge'
import type { DshProviderInjection } from './modelInjection'

export interface ComposeDshRuntimeInput {
  cwd: string
  dshHome: string
  sessionRoot: string
  injection: DshProviderInjection
  prompt: string
  includeHarnessIdentity: boolean
  skillDirs: string[]
  mcpTools: readonly ToolDefinition[]
  permissionMode: Exclude<AgentPermissionMode, 'auto'>
  interaction: DshInteractionBridgeContext
}

/**
 * One isolated, Cherry-owned DSH plugin tree. It deliberately composes only
 * pinned DSH packages and Cherry bridges; it never discovers user plugins.
 */
export class DshRuntimeComposition {
  readonly ctx = new Context()

  private constructor() {}

  static async create(input: ComposeDshRuntimeInput): Promise<DshRuntimeComposition> {
    const composition = new DshRuntimeComposition()
    try {
      await composition.install(input)
      return composition
    } catch (error) {
      await composition.dispose()
      throw error
    }
  }

  async createOrResume({ sessionId, resume }: { sessionId: string; resume: boolean }): Promise<AgentHandle> {
    const setup = (agentCtx: Context) => {
      for (const tool of this.mcpTools) agentCtx.tools.register(tool)
    }
    const agentOptions = {
      provider: this.injection.providerRoute,
      model: this.injection.modelId,
      ...(this.injection.maxTokens ? { maxTokens: this.injection.maxTokens } : {})
    }
    const dshSessionId = SessionId(sessionId)
    // Cherry can retain a resume token after its local DSH artifact has been
    // cleared (for example after migration or manual data cleanup). Treat that
    // as a fresh session, while still surfacing corrupt/incompatible artifacts.
    const canResume = resume && (await this.ctx.sessionPersistence.readRaw(dshSessionId)) !== undefined
    const handle = canResume
      ? await this.ctx.agents.resume({ resumeSessionId: dshSessionId, agentOptions, setup })
      : await this.ctx.agents.create({ sessionId: dshSessionId, meta: { cwd: this.cwd }, agentOptions, setup })
    this.ctx.permissionPresets.set(handle.agent.session, this.permissionMode)
    // Plan state is event-sourced by DSH, so an explicit false is required when
    // a persisted plan session is reopened under another Cherry permission.
    this.ctx.planMode.set(handle.agent, this.permissionMode === 'plan')
    return handle
  }

  async dispose(): Promise<void> {
    await this.ctx.fiber.dispose()
  }

  private readonly cwd!: string
  private readonly injection!: DshProviderInjection
  private readonly mcpTools!: readonly ToolDefinition[]
  private readonly permissionMode!: Exclude<AgentPermissionMode, 'auto'>

  private async install(input: ComposeDshRuntimeInput): Promise<void> {
    Object.assign(this, {
      cwd: input.cwd,
      injection: input.injection,
      mcpTools: input.mcpTools,
      permissionMode: input.permissionMode
    })
    await this.ctx.plugin(LocalSubprocessRuntime)
    await this.ctx.plugin(LocalAttachmentStore, { dshHome: input.dshHome })
    await this.ctx.plugin(LocalSandboxProvider)
    await this.ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: input.cwd })
    await this.ctx.plugin(SandboxBashExecutor, { cwd: input.cwd, timeoutMs: 60_000 })
    await this.ctx.plugin(SandboxedFileSystem, { cwd: input.cwd })
    await this.ctx.plugin(AgentSpine, {
      includeHarnessIdentity: input.includeHarnessIdentity,
      persona: input.prompt,
      tools: { mode: 'native' },
      dshHome: input.dshHome,
      workspaceContext: { maxBytes: 32_768 },
      skills: {
        filesystem: {
          includeDefaultRoots: false,
          customSkillDirs: input.skillDirs,
          watch: false
        }
      },
      toolBash: { enableRunInBackground: false },
      toolJobs: false
    })
    await installDshModelBridge(this.ctx, input.injection)
    await this.ctx.plugin(JsonlSessionPersistence, { root: input.sessionRoot })
    await this.ctx.plugin(SessionCheckpointPolicy)
    await this.ctx.plugin(ApprovalService, { policy: 'ask' })
    await this.ctx.plugin(PermissionPresetService, {
      defaultPreset: 'default',
      presets: {
        default: { sandbox: 'workspace-write', approval: 'ask' },
        acceptEdits: { sandbox: 'workspace-write', approval: 'ask' },
        plan: { sandbox: 'read-only', approval: 'ask' },
        bypassPermissions: { sandbox: 'danger-full-access', approval: 'never' }
      }
    })
    await this.ctx.plugin(UserQuestionService)
    await this.ctx.plugin(ToolAskUser)
    this.ctx.effect(() => installDshInteractionBridge(this.ctx, input.interaction), 'cherry-dsh: interaction bridge')
    await this.ctx.plugin(PlanModeController, {
      section: 'Explore and design before presenting a complete plan through exit_plan_mode.'
    })
    await this.ctx.plugin(FsObservationPolicy)
    await this.ctx.plugin(ToolFs)
    await this.ctx.plugin(TokenMeter)
    await this.ctx.plugin(ToolResultPruner)
    await this.ctx.plugin(BasicCompactionEngine)
    await this.ctx.plugin(SubagentRuntime)
    await this.ctx.plugin(InProcessSubagent, { providerName: 'cherry-foreground' })
    await this.ctx.plugin(ToolSubagent, {
      provider: 'cherry-foreground',
      enableRunInBackground: false,
      maxDepth: 1
    })
    await this.ctx.plugin(ToolTodo, { allowParallelInProgress: false })
  }
}

export function composeDshRuntime(input: ComposeDshRuntimeInput): Promise<DshRuntimeComposition> {
  return DshRuntimeComposition.create(input)
}
