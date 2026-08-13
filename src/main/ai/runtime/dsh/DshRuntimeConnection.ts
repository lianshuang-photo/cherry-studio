import { mkdirSync } from 'node:fs'

import { application } from '@application'
import { agentChannelService } from '@data/services/AgentChannelService'
import { agentService } from '@data/services/AgentService'
import { agentSessionService } from '@data/services/AgentSessionService'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { loggerService } from '@logger'
import { ensureAgentDataDirectory } from '@main/ai/agents/agentDataDirectory'
import { buildAgentMcpServers } from '@main/ai/runtime/agentMcpServers'
import { buildAgentRuntimePrompt } from '@main/ai/runtime/agentPrompt'
import { warmMcpToolCatalogs } from '@main/ai/runtime/mcpToolCatalog'
import {
  ASSISTANT_APPROVAL_REQUIRED_RUNTIME_NAMES,
  ASSISTANT_FILE_APPROVAL_REQUIRED_RUNTIME_NAMES,
  CHERRY_BUILTIN_APPROVAL_REQUIRED_TOOL_NAMES
} from '@main/ai/runtime/toolApproval/cherryBuiltinApproval'
import { skillService } from '@main/ai/skills/SkillService'
import { wrapSteerReminder } from '@main/ai/steerReminder'
import type { AgentSessionContextUsage } from '@shared/ai/agentSessionContextUsage'
import { DSH_BUILTIN_TOOLS } from '@shared/ai/dshBuiltinTools'

import { buildAgentUserContent } from '../agentUserContent'
import { AsyncEventQueue } from '../AsyncEventQueue'
import { toolApprovalRegistry } from '../toolApproval/ToolApprovalRegistry'
import type {
  AgentRuntimeConnectInput,
  AgentRuntimeConnection,
  AgentRuntimeEvent,
  AgentRuntimeReconcileResult,
  AgentRuntimeUserInput,
  AgentSessionUsageCapture
} from '../types'
import type { DshInteractionBridgeContext } from './DshInteractionBridge'
import { buildDshMcpToolDefinitions, type DshMcpToolBridge } from './dshMcpToolAdapter'
import { composeDshRuntime, type DshRuntimeComposition } from './DshRuntimeComposition'
import { DshStreamAdapter } from './dshStreamAdapter'
import { resolveDshProviderInjection } from './modelInjection'

const logger = loggerService.withContext('DshRuntimeConnection')
const DSH_BUILTIN_TOOL_ALIASES = new Map(DSH_BUILTIN_TOOLS.map((tool) => [tool.name.toLowerCase(), tool.name]))

interface PendingSteer {
  input: AgentRuntimeUserInput
}

/** In-process DeepSeek Harness runtime, isolated to one Cherry Agent session. */
export class DshRuntimeConnection implements AgentRuntimeConnection {
  private readonly eventQueue = new AsyncEventQueue<AgentRuntimeEvent>()
  private readonly adapter = new DshStreamAdapter({
    enqueue: (chunk) => this.eventQueue.push({ type: 'chunk', chunk })
  })
  private readonly committedInvocationIds = new Set<string>()
  private readonly pendingSteers = new Map<string, PendingSteer>()
  private composition?: DshRuntimeComposition
  private handle?: AgentHandle
  private agent?: Agent
  private mcpBridge?: DshMcpToolBridge
  private unsubscribeSession?: () => void
  private unsubscribeStatus?: () => void
  private unsubscribeInbox?: () => void
  private closed = false
  private turnActive = false
  private modelId = ''
  private contextWindow = 0
  private _usageCapture?: AgentSessionUsageCapture

  readonly events = this.eventQueue

  get usageCapture(): AgentSessionUsageCapture | undefined {
    return this._usageCapture
  }

  constructor(private readonly input: AgentRuntimeConnectInput) {}

  async start(): Promise<this> {
    const cherryAgent = agentService.getAgent(this.input.agentId)
    const cherrySession = agentSessionService.getById(this.input.sessionId)
    const cwd = cherrySession?.workspace?.path
    if (!cherryAgent?.model) throw new Error(`dsh agent ${this.input.agentId} has no model configured`)
    if (!cherrySession?.agentId || cherrySession.agentId !== cherryAgent.id || !cwd) {
      throw new Error(`dsh agent session ${this.input.sessionId} has no agent or workspace configured`)
    }

    await warmMcpToolCatalogs(cherryAgent.mcps ?? [])

    const injection = await resolveDshProviderInjection(this.input.modelId)
    this.modelId = injection.modelId
    this.contextWindow = injection.contextWindow ?? 0
    this._usageCapture = injection.usageCapture

    const dshHome = application.getPath('feature.agents.dsh.root')
    const sessionRoot = application.getPath('feature.agents.dsh.sessions')
    mkdirSync(dshHome, { recursive: true })
    mkdirSync(sessionRoot, { recursive: true })

    const [installedSkills, agentDataPath] = await Promise.all([
      skillService.list({ agentId: cherryAgent.id }),
      ensureAgentDataDirectory(application.getPath('feature.agents.data'), cherryAgent.id)
    ])
    const linkedChannel = agentChannelService.findBySessionId(cherrySession.id)
    const prompt = await buildAgentRuntimePrompt({
      workspacePath: cwd,
      agentDataPath,
      agent: cherryAgent,
      channelLinked: linkedChannel !== null,
      customBaseContext: [
        '## Current Workspace',
        `Current working directory: ${JSON.stringify(cwd)}`,
        'Resolve relative file and shell paths against this directory.'
      ].join('\n')
    })
    const persona =
      prompt.base.kind === 'custom' ? [prompt.base.content, prompt.append].filter(Boolean).join('\n\n') : prompt.append
    const assistantMcpEnabled = cherryAgent.configuration?.builtin_role === 'assistant' && !linkedChannel
    const permissionMode = normalizePermissionMode(cherryAgent.configuration?.permission_mode)
    this.mcpBridge = await buildDshMcpToolDefinitions(
      buildAgentMcpServers(
        cherrySession,
        cherryAgent,
        assistantMcpEnabled,
        undefined,
        linkedChannel ? { id: linkedChannel.id } : null,
        agentDataPath,
        this.input.knowledgeBaseIds
      )
    )
    const disabledTools = normalizeDisabledTools(cherryAgent.disabledTools)

    logger.info('starting in-process dsh runtime', {
      model: injection.modelId,
      providerRoute: injection.providerRoute,
      baseHost: hostOf(injection.baseURL),
      cwd
    })
    try {
      this.composition = await composeDshRuntime({
        cwd,
        dshHome,
        sessionRoot,
        injection,
        prompt: persona,
        includeHarnessIdentity: prompt.base.kind === 'native',
        skillDirs: installedSkills
          .filter((skill) => skill.isEnabled)
          .map((skill) => skillService.getInstalledSkillDirectory(skill)),
        mcpTools: this.mcpBridge.tools.filter((tool) => !disabledTools.has(tool.name)),
        permissionMode,
        interaction: this.buildInteractionBridge(cherryAgent.disabledTools, permissionMode)
      })
      this.handle = await this.composition.createOrResume({
        sessionId: this.input.sessionId,
        resume: Boolean(this.input.resumeToken)
      })
      this.agent = this.handle.agent
      this.subscribe(this.composition, this.agent)
      this.eventQueue.push({ type: 'resume-token', token: this.input.sessionId })
      return this
    } catch (error) {
      await this.cleanupStartedResources()
      throw error
    }
  }

  send(input: AgentRuntimeUserInput): void {
    const agent = this.agent
    if (this.closed || !agent) {
      this.eventQueue.push({ type: 'error', error: new Error('dsh session is not started') })
      return
    }
    if (this.turnActive || agent.status === 'running') {
      this.eventQueue.push({ type: 'error', error: new Error('dsh turn already running') })
      return
    }
    this.adapter.resetTurn()
    this.turnActive = true
    const raw = buildAgentUserContent(input.message)
    const text = input.systemReminder ? wrapSteerReminder(raw) : raw
    try {
      agent.followup(toDshUserMessage(text))
    } catch (error) {
      this.finishTurn(error)
    }
  }

  redirect(input: AgentRuntimeUserInput): boolean {
    const agent = this.agent
    if (this.closed || !this.turnActive || !agent || agent.status !== 'running') return false
    const message = toDshUserMessage(wrapSteerReminder(buildAgentUserContent(input.message)))
    this.pendingSteers.set(message.id, { input })
    try {
      agent.steer(message)
      return true
    } catch (error) {
      this.pendingSteers.delete(message.id)
      logger.error('dsh steer failed', error as Error)
      this.eventQueue.push({ type: 'error', error })
      return false
    }
  }

  async reconcile(): Promise<AgentRuntimeReconcileResult> {
    return 'rebuild'
  }

  async getContextUsage(): Promise<AgentSessionContextUsage | null> {
    return this.measureContextUsage()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    toolApprovalRegistry.abort(this.input.sessionId, 'dsh-session-closed')
    this.unsubscribeSession?.()
    this.unsubscribeStatus?.()
    this.unsubscribeInbox?.()
    this.unsubscribeSession = undefined
    this.unsubscribeStatus = undefined
    this.unsubscribeInbox = undefined
    try {
      this.agent?.cancel({ kind: 'disposed' })
    } catch (error) {
      logger.warn('dsh agent cancel failed during close', { error })
    }
    await this.cleanupStartedResources()
    this.eventQueue.close()
  }

  private subscribe(composition: DshRuntimeComposition, rootAgent: Agent): void {
    this.unsubscribeSession = composition.ctx.on('session/event', (session: Session, event: SessionEvent) => {
      if (this.closed || session !== rootAgent.session) return
      this.handleSessionEvent(event)
    })
    this.unsubscribeStatus = composition.ctx.on('agent/status', ({ agent, status }) => {
      if (this.closed || agent !== rootAgent || status !== 'idle' || !this.turnActive) return
      this.finishTurn(lastTurnError(rootAgent.session.events))
    })
    this.unsubscribeInbox = composition.ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      if (this.closed || agent !== rootAgent) return
      const pending = this.pendingSteers.get(message.id)
      if (!pending) return
      this.pendingSteers.delete(message.id)
      this.input.onSteerInjected?.([pending.input])
      this.eventQueue.push({ type: 'steer-boundary', inputs: [pending.input] })
    })
  }

  private buildInteractionBridge(
    disabledTools: readonly string[] | undefined,
    permissionMode: ReturnType<typeof normalizePermissionMode>
  ): DshInteractionBridgeContext {
    const disabled = normalizeDisabledTools(disabledTools)
    const approvalRequiredTools = new Set([
      ...CHERRY_BUILTIN_APPROVAL_REQUIRED_TOOL_NAMES.map((name) => `mcp__cherry-tools__${name}`),
      ...ASSISTANT_APPROVAL_REQUIRED_RUNTIME_NAMES,
      ...ASSISTANT_FILE_APPROVAL_REQUIRED_RUNTIME_NAMES
    ])
    return {
      sessionId: this.input.sessionId,
      emit: (event) => this.eventQueue.push(event),
      getInteractionState: () =>
        application.get('AgentSessionRuntimeService').getInteractionState(this.input.sessionId),
      // Runtime configuration changes are applied by Cherry through reconcile()
      // and a connection rebuild, never halfway through an active turn.
      getPermissionMode: () => permissionMode,
      isDisabled: (toolName) => disabled.has(toolName),
      approvalRequiredTools
    }
  }

  private handleSessionEvent(event: SessionEvent): void {
    this.adapter.handleSessionEvent(event as { type: string; data?: Record<string, unknown> })
    if (event.type === 'assistant/message' && event.data.usage) this.recordUsage(event)
    const observableEvent: { type: string; data: unknown } = event
    if (isLlmRetryEvent(observableEvent)) this.emitApiRetry(observableEvent.data)
    if (event.type === 'compaction/start') {
      this.eventQueue.push({ type: 'compaction-start' })
    } else if (event.type === 'compaction/summary' && event.data.usage) {
      this.recordCompactionUsage(event)
    } else if (event.type === 'compaction/end') {
      this.eventQueue.push(
        event.data.error ? { type: 'compaction-error', error: event.data.error } : { type: 'compaction-complete' }
      )
    }
    if (event.type === 'turn/end' && event.data.reason.kind === 'error') {
      logger.warn('dsh turn ended with an error', { sessionId: this.input.sessionId, error: event.data.reason.error })
    }
  }

  private emitApiRetry(data: DshLlmRetryEventData): void {
    if (!this.turnActive) return
    if (data.mode === 'always') {
      logger.warn('dsh retry cannot be represented by Cherry retry status', {
        sessionId: this.input.sessionId,
        retryId: data.retryId,
        mode: data.mode
      })
      return
    }
    this.eventQueue.push({
      type: 'api-retry',
      retry: {
        attempt: data.retry,
        maxRetries: data.maxRetries,
        retryDelayMs: data.delayMs,
        errorStatus: data.failure.status ?? null,
        errorCategory: data.failure.code
      }
    })
  }

  private recordCompactionUsage(event: Extract<SessionEvent, { type: 'compaction/summary' }>): void {
    if (this._usageCapture?.owner !== 'agent-sdk' || !event.data.usage) return
    const requestId = `dsh-agent:${this.input.sessionId}:compaction:${event.data.compactionId}`
    if (this.committedInvocationIds.has(requestId)) return
    this.committedInvocationIds.add(requestId)
    this.emitUsage(requestId, event.data.model, event.data.usage)
  }

  private recordUsage(event: Extract<SessionEvent, { type: 'assistant/message' }>): void {
    if (this._usageCapture?.owner !== 'agent-sdk') return
    const usage = event.data.usage
    if (!usage) return
    const requestId = `dsh-agent:${this.input.sessionId}:${event.data.turn}:${event.data.step}`
    if (this.committedInvocationIds.has(requestId)) return
    this.committedInvocationIds.add(requestId)
    this.emitUsage(requestId, event.data.message.source.model || this.modelId, usage)
  }

  private emitUsage(
    requestId: string,
    model: string,
    usage: {
      inputTokens: number
      outputTokens: number
      cacheReadTokens?: number
      cacheWriteTokens?: number
      reasoningTokens?: number
    }
  ): void {
    const noCacheTokens = finiteTokens(usage.inputTokens)
    const cacheReadTokens = finiteTokens(usage.cacheReadTokens)
    const cacheWriteTokens = finiteTokens(usage.cacheWriteTokens)
    const inputTokens = noCacheTokens + cacheReadTokens + cacheWriteTokens
    const outputTokens = finiteTokens(usage.outputTokens)
    this.eventQueue.push({
      type: 'usage',
      invocation: {
        requestId,
        model: model || this.modelId,
        messageAssociation: 'current-turn',
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          ...(usage.reasoningTokens !== undefined ? { reasoningTokens: finiteTokens(usage.reasoningTokens) } : {}),
          noCacheTokens,
          cacheReadTokens,
          cacheWriteTokens
        }
      }
    })
  }

  private finishTurn(error?: unknown): void {
    if (!this.turnActive || this.closed) return
    this.turnActive = false
    const undelivered = [...this.pendingSteers.values()].map(({ input }) => input)
    this.pendingSteers.clear()
    if (undelivered.length > 0) this.eventQueue.push({ type: 'steer-undelivered', inputs: undelivered })
    if (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      logger.error('dsh turn failed', failure)
      this.eventQueue.push({ type: 'error', error: failure })
      return
    }
    this.emitContextUsage()
    this.eventQueue.push({ type: 'turn-complete' })
  }

  private emitContextUsage(): void {
    try {
      const usage = this.measureContextUsage()
      if (usage && !this.closed) this.eventQueue.push({ type: 'context-usage', usage })
    } catch (error) {
      logger.warn('failed to measure dsh context usage', { error })
    }
  }

  private measureContextUsage(): AgentSessionContextUsage | null {
    const composition = this.composition
    const agent = this.agent
    if (!composition || !agent || !this.contextWindow) return null
    const measurement = composition.ctx.tokenMeter.measure(agent.session)
    return {
      categories: [],
      totalTokens: measurement.totalTokens,
      maxTokens: this.contextWindow,
      percentage: Math.min(100, (measurement.totalTokens / this.contextWindow) * 100),
      model: this.modelId
    }
  }

  private async cleanupStartedResources(): Promise<void> {
    const handle = this.handle
    const composition = this.composition
    const mcpBridge = this.mcpBridge
    this.handle = undefined
    this.composition = undefined
    this.mcpBridge = undefined
    this.agent = undefined
    const settled = await Promise.allSettled([handle?.dispose(), composition?.dispose(), mcpBridge?.close()])
    for (const result of settled) {
      if (result.status === 'rejected') logger.warn('dsh runtime cleanup failed', { error: result.reason })
    }
  }
}

function toDshUserMessage(text: string) {
  return createUserMessage({ content: [{ type: 'text' as const, text }], source: { kind: 'user' as const } })
}

function lastTurnError(events: readonly SessionEvent[]): Error | undefined {
  const end = events.findLast((event) => event.type === 'turn/end')
  if (end?.type !== 'turn/end' || end.data.reason.kind !== 'error') return undefined
  return new Error(end.data.reason.error.message || 'DeepSeek Harness turn failed')
}

function normalizePermissionMode(mode: string | undefined): 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' {
  return mode === 'acceptEdits' || mode === 'plan' || mode === 'bypassPermissions' ? mode : 'default'
}

function normalizeDisabledTools(disabledTools: readonly string[] | undefined): Set<string> {
  return new Set((disabledTools ?? []).map((tool) => DSH_BUILTIN_TOOL_ALIASES.get(tool.toLowerCase()) ?? tool))
}

function finiteTokens(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

type DshLlmRetryEventData =
  | {
      retryId: string
      mode: 'normal'
      retry: number
      maxRetries: number
      delayMs: number
      failure: { code: string; status?: number }
    }
  | {
      retryId: string
      mode: 'always'
      retry: number
      delayMs: number
      failure: { code: string; status?: number }
    }

function isLlmRetryEvent(event: {
  type: string
  data: unknown
}): event is { type: 'llm/retry'; data: DshLlmRetryEventData } {
  if (event.type !== 'llm/retry' || !isRecord(event.data)) return false
  const data = event.data
  if (
    typeof data.retryId !== 'string' ||
    (data.mode !== 'normal' && data.mode !== 'always') ||
    !isPositiveInteger(data.retry) ||
    !isNonNegativeNumber(data.delayMs) ||
    !isRetryFailure(data.failure)
  ) {
    return false
  }
  return data.mode === 'always' || isPositiveInteger(data.maxRetries)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isRetryFailure(value: unknown): value is { code: string; status?: number } {
  const status = isRecord(value) ? value.status : undefined
  return (
    isRecord(value) &&
    typeof value.code === 'string' &&
    value.code.length > 0 &&
    (status === undefined || (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599))
  )
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}
