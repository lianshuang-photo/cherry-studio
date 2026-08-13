import { mkdirSync } from 'node:fs'

import { application } from '@application'
import { agentService } from '@data/services/AgentService'
import { agentSessionService } from '@data/services/AgentSessionService'
import { loggerService } from '@logger'
import { wrapSteerReminder } from '@main/ai/steerReminder'
import type { AgentSessionContextUsage } from '@shared/ai/agentSessionContextUsage'

import { buildAgentUserContent } from '../agentUserContent'
import { AsyncEventQueue } from '../AsyncEventQueue'
import type {
  AgentRuntimeConnectInput,
  AgentRuntimeConnection,
  AgentRuntimeEvent,
  AgentRuntimeReconcileResult,
  AgentRuntimeUserInput
} from '../types'
import { DshSdkProcess, type DshWireEvent } from './dshSdk'
import { DshStreamAdapter } from './dshStreamAdapter'
import { resolveDshProviderInjection } from './modelInjection'

const logger = loggerService.withContext('DshRuntimeConnection')

export class DshRuntimeConnection implements AgentRuntimeConnection {
  private readonly eventQueue = new AsyncEventQueue<AgentRuntimeEvent>()
  private readonly adapter = new DshStreamAdapter({
    enqueue: (chunk) => this.eventQueue.push({ type: 'chunk', chunk })
  })
  private process: DshSdkProcess | undefined
  private modelName = ''
  private cwd = ''
  private closed = false
  private busy = false
  private turnOpen = false
  private lastUsage: AgentSessionContextUsage | null = null

  readonly events = this.eventQueue

  constructor(private readonly input: AgentRuntimeConnectInput) {}

  async start(): Promise<this> {
    const agent = agentService.getAgent(this.input.agentId)
    const session = agentSessionService.getById(this.input.sessionId)
    const cwd = session?.workspace?.path
    if (!agent?.model) {
      throw new Error(`dsh agent ${this.input.agentId} has no model configured`)
    }
    if (!cwd) {
      throw new Error(`dsh agent session ${this.input.sessionId} has no workspace configured`)
    }

    const injection = await resolveDshProviderInjection(this.input.modelId)
    this.modelName = injection.modelId
    this.cwd = cwd

    const home = application.getPath('feature.agents.dsh.root')
    const sessions = application.getPath('feature.agents.dsh.sessions')
    mkdirSync(home, { recursive: true })
    mkdirSync(sessions, { recursive: true })

    logger.info('starting dsh runtime', {
      model: injection.modelId,
      hasCustomBaseUrl: Boolean(injection.baseUrl),
      baseHost: hostOf(injection.baseUrl),
      cwd
    })
    this.process = new DshSdkProcess({
      ...process.env,
      DEEPSEEK_API_KEY: injection.apiKey,
      ...(injection.baseUrl ? { DEEPSEEK_BASE_URL: injection.baseUrl } : {}),
      DSH_HOME: home,
      DSH_SESSION_ROOT: sessions,
      DSH_CWD: cwd,
      DSH_PROVIDER: 'deepseek-official',
      DSH_MODEL: injection.modelId
    })

    const resume = this.input.resumeToken || this.input.sessionId
    this.eventQueue.push({ type: 'resume-token', token: resume })
    return this
  }

  async send(input: AgentRuntimeUserInput): Promise<void> {
    if (this.closed || !this.process) {
      this.eventQueue.push({ type: 'error', error: new Error('dsh session is not started') })
      return
    }
    if (this.busy) {
      this.eventQueue.push({ type: 'error', error: new Error('dsh turn already running') })
      return
    }
    this.busy = true
    this.turnOpen = true
    try {
      const raw = buildAgentUserContent(input.message)
      const text = input.systemReminder ? wrapSteerReminder(raw) : raw
      await this.process.prompt({
        sessionId: this.input.resumeToken || this.input.sessionId,
        text,
        cwd: this.cwd,
        model: this.modelName,
        onEvent: (wire) => this.ingest(wire)
      })
    } catch (error) {
      logger.error('dsh turn failed', error as Error)
      this.eventQueue.push({ type: 'error', error })
    } finally {
      if (this.turnOpen) this.eventQueue.push({ type: 'turn-complete' })
      this.turnOpen = false
      this.busy = false
    }
  }

  async reconcile(): Promise<AgentRuntimeReconcileResult> {
    return 'current'
  }

  async getContextUsage(): Promise<AgentSessionContextUsage | null> {
    return this.lastUsage
  }

  async close(): Promise<void> {
    this.closed = true
    await this.process?.close()
    this.eventQueue.close()
  }

  private ingest(wire: DshWireEvent): void {
    if (wire.kind === 'session-event' && wire.event) {
      this.adapter.handleSessionEvent(wire.event)
      const usage = this.adapter.getUsage()
      if (usage.totalTokens > 0) {
        this.lastUsage = {
          categories: [],
          totalTokens: usage.totalTokens,
          maxTokens: 1_000_000,
          percentage: Math.min(100, (usage.totalTokens / 1_000_000) * 100),
          model: this.modelName
        }
        this.eventQueue.push({ type: 'context-usage', usage: this.lastUsage })
      }
      return
    }
    if (wire.kind === 'error') {
      this.eventQueue.push({ type: 'error', error: new Error(wire.message || 'dsh runtime error') })
    }
    if (wire.kind === 'result') {
      const failed = Boolean(wire.finishReason && wire.finishReason !== 'completed')
      const detail = this.adapter.getLastError() || wire.errorMessage
      if (wire.finalResponse && !this.adapter.hasStreamedText()) {
        this.adapter.emitText(wire.finalResponse)
      }
      if (failed || !wire.finalResponse) {
        logger.warn('dsh turn returned no assistant text', {
          finishReason: wire.finishReason,
          sessionId: wire.sessionId,
          errorMessage: detail
        })
        if (failed) {
          this.eventQueue.push({
            type: 'error',
            error: new Error(detail || `DeepSeek Harness 本轮结束：${wire.finishReason}`)
          })
        }
      }
    }
    // Like Pi's agent_end: one Cherry turn spans the whole dsh run (idle),
    // not each inner turn/end after a tool call.
    if (wire.kind === 'result') {
      if (this.turnOpen) {
        this.turnOpen = false
        this.eventQueue.push({ type: 'turn-complete' })
      }
    }
  }
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}
