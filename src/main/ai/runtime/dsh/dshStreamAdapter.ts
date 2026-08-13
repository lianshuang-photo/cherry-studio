/**
 * Translate dsh SessionEvents into Cherry UIMessageChunks.
 * Transport tag comes from the shared descriptor — do not redeclare it.
 */
import { AGENT_RUNTIME_CAPABILITIES } from '@shared/ai/agentRuntimeCapabilities'
import type { CherryUIMessageChunk } from '@shared/data/types/message'

export const DSH_TRANSPORT = AGENT_RUNTIME_CAPABILITIES.dsh.transport

export interface DshStreamSink {
  enqueue(chunk: CherryUIMessageChunk): void
}

type DshSessionEvent = {
  type: string
  data?: Record<string, unknown>
}

export class DshStreamAdapter {
  private messageSeq = 0
  private readonly startedTools = new Set<string>()
  private turnUsage = emptyUsage()
  private openText = false
  private openReasoning = false
  private lastError: string | undefined
  private emittedText = false

  constructor(private readonly sink: DshStreamSink) {}

  resetTurn(): void {
    this.turnUsage = emptyUsage()
    this.openText = false
    this.openReasoning = false
    this.startedTools.clear()
    this.lastError = undefined
    this.emittedText = false
  }

  handleSessionEvent(event: DshSessionEvent): void {
    const data = event.data && typeof event.data === 'object' ? event.data : {}
    switch (event.type) {
      case 'turn/start':
        // A Cherry turn can span several dsh turns (tool loop). Close open
        // parts but keep tool ids so later results still match.
        this.closeOpenParts()
        this.lastError = undefined
        return
      case 'step/start':
        this.closeOpenParts()
        this.messageSeq += 1
        this.emittedText = false
        return
      case 'assistant/chunk':
        this.handleChunk(data.chunk)
        return
      case 'text-chunks':
        this.handlePackedTexts('text-delta', data.texts)
        return
      case 'reasoning-chunks':
        this.handlePackedTexts('reasoning-delta', data.texts)
        return
      case 'turn/end': {
        const message = extractFailureMessage(data.reason)
        if (message) this.lastError = message
        this.closeOpenParts()
        return
      }
      case 'tool/call':
        this.handleToolCall(data)
        return
      case 'tool/result':
        this.handleToolResult(data)
        return
      case 'assistant/message':
        this.flushAssistantMessage(data)
        return
      default:
        return
    }
  }

  getUsage() {
    return { ...this.turnUsage }
  }

  getLastError(): string | undefined {
    return this.lastError
  }

  hasStreamedText(): boolean {
    return this.emittedText
  }

  emitText(text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    this.handleChunk({ type: 'text-delta', text: trimmed })
    this.closeOpenParts()
  }

  private handlePackedTexts(kind: 'text-delta' | 'reasoning-delta', texts: unknown): void {
    if (!Array.isArray(texts)) return
    for (const text of texts) {
      if (typeof text === 'string' && text) this.handleChunk({ type: kind, text })
    }
  }

  private flushAssistantMessage(data: Record<string, unknown>): void {
    if (!this.emittedText) {
      for (const block of contentBlocks(data)) {
        if (block.type === 'text' && typeof block.text === 'string') {
          this.handleChunk({ type: 'text-delta', text: block.text })
        }
      }
    }
    this.closeOpenParts()
    if (data.usage) this.accumulateUsage(data.usage as Record<string, unknown>)
  }

  private handleChunk(chunk: unknown): void {
    if (!chunk || typeof chunk !== 'object') return
    const record = chunk as Record<string, unknown>
    if (record.type === 'finish') {
      const message = extractFailureMessage(record.reason)
      if (message) this.lastError = message
      return
    }
    const idBase = `dsh-${this.messageSeq}`
    if (record.type === 'text-delta' && typeof record.text === 'string') {
      if (!this.openText) {
        this.sink.enqueue({ type: 'text-start', id: `${idBase}-text` })
        this.openText = true
      }
      this.emittedText = true
      this.sink.enqueue({ type: 'text-delta', id: `${idBase}-text`, delta: record.text })
      return
    }
    if (record.type === 'reasoning-delta' && typeof record.text === 'string') {
      if (!this.openReasoning) {
        this.sink.enqueue({ type: 'reasoning-start', id: `${idBase}-reasoning` })
        this.openReasoning = true
      }
      this.sink.enqueue({ type: 'reasoning-delta', id: `${idBase}-reasoning`, delta: record.text })
    }
  }

  private handleToolCall(data: Record<string, unknown>): void {
    const toolCallId = extractToolCallId(data) || `call-${this.startedTools.size}`
    if (this.startedTools.has(toolCallId)) return
    this.startedTools.add(toolCallId)
    const toolName = String(data.name ?? 'unknown')
    const input = parseArgs(data.arguments)
    const meta = toolMetadata(toolName)
    this.sink.enqueue({
      type: 'tool-input-start',
      toolCallId,
      toolName,
      providerExecuted: true,
      dynamic: true,
      providerMetadata: meta
    })
    this.sink.enqueue({
      type: 'tool-input-available',
      toolCallId,
      toolName,
      input,
      providerExecuted: true,
      dynamic: true,
      providerMetadata: meta
    })
  }

  private handleToolResult(data: Record<string, unknown>): void {
    const message = data.message && typeof data.message === 'object' ? (data.message as Record<string, unknown>) : {}
    const toolCallId = extractToolCallId(data)
    const toolName = String(data.name ?? message.name ?? 'bash')
    if (toolCallId && !this.startedTools.has(toolCallId)) {
      this.handleToolCall({ callId: toolCallId, name: toolName, arguments: '{}' })
    }
    const meta = toolMetadata(toolName)
    const resultError = data.error ?? blockError(message)
    if (resultError) {
      this.sink.enqueue({
        type: 'tool-output-error',
        toolCallId,
        errorText: stringify(resultError),
        dynamic: true,
        providerExecuted: true,
        providerMetadata: meta
      })
      return
    }
    this.sink.enqueue({
      type: 'tool-output-available',
      toolCallId,
      output: extractToolOutput(message),
      dynamic: true,
      providerExecuted: true,
      providerMetadata: meta
    })
  }

  private closeOpenParts(): void {
    if (this.openText) {
      this.sink.enqueue({ type: 'text-end', id: `dsh-${this.messageSeq}-text` })
      this.openText = false
    }
    if (this.openReasoning) {
      this.sink.enqueue({ type: 'reasoning-end', id: `dsh-${this.messageSeq}-reasoning` })
      this.openReasoning = false
    }
  }

  private accumulateUsage(usage: Record<string, unknown>): void {
    this.turnUsage.inputTokens += num(usage.input ?? usage.inputTokens)
    this.turnUsage.outputTokens += num(usage.output ?? usage.outputTokens)
    this.turnUsage.totalTokens = this.turnUsage.inputTokens + this.turnUsage.outputTokens
  }
}

function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
}

function toolMetadata(toolName: string) {
  return {
    cherry: { transport: DSH_TRANSPORT, tool: { type: 'builtin', name: toolName } },
    dsh: { toolName }
  }
}

function parseArgs(raw: unknown): unknown {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return { raw }
  }
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function extractToolCallId(data: Record<string, unknown>): string {
  if (typeof data.callId === 'string' && data.callId) return data.callId
  if (typeof data.toolCallId === 'string' && data.toolCallId) return data.toolCallId
  const message = data.message && typeof data.message === 'object' ? (data.message as Record<string, unknown>) : {}
  if (typeof message.toolCallId === 'string' && message.toolCallId) return message.toolCallId
  if (typeof message.callId === 'string' && message.callId) return message.callId
  const source = message.source && typeof message.source === 'object' ? (message.source as Record<string, unknown>) : {}
  if (typeof source.callId === 'string' && source.callId) return source.callId
  for (const block of contentBlocks(data)) {
    if (typeof block.toolCallId === 'string' && block.toolCallId) return block.toolCallId
  }
  return ''
}

function contentBlocks(data: Record<string, unknown>): Array<Record<string, unknown>> {
  const message = data.message && typeof data.message === 'object' ? (data.message as Record<string, unknown>) : data
  const content = message.content
  return Array.isArray(content)
    ? content.filter((block): block is Record<string, unknown> => Boolean(block && typeof block === 'object'))
    : []
}

function extractToolOutput(message: Record<string, unknown>): unknown {
  const texts: string[] = []
  const content = message.content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const inner = (block as Record<string, unknown>).content
      if (Array.isArray(inner)) {
        for (const part of inner) {
          if (part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string') {
            texts.push(String((part as Record<string, unknown>).text))
          }
        }
      } else if (typeof inner === 'string') {
        texts.push(inner)
      }
    }
  }
  if (texts.length > 0) return texts.join('')
  if (message.result !== undefined) return message.result
  return message
}

function blockError(message: Record<string, unknown>): unknown {
  for (const block of contentBlocks({ message })) {
    if (block.isError) return block.content ?? block
  }
  return undefined
}

function extractFailureMessage(reason: unknown): string | undefined {
  if (!reason || typeof reason !== 'object') return undefined
  const record = reason as Record<string, unknown>
  if (record.kind !== 'error') return undefined
  const failure =
    record.failure && typeof record.failure === 'object' ? (record.failure as Record<string, unknown>) : null
  const error = record.error && typeof record.error === 'object' ? (record.error as Record<string, unknown>) : null
  const source = failure ?? error
  if (!source) return typeof record.error === 'string' ? record.error : undefined
  const message = typeof source.message === 'string' ? source.message.trim() : ''
  const code = typeof source.code === 'string' ? source.code.trim() : ''
  if (message && code && !message.includes(code)) return `${message} (${code})`
  return message || code || undefined
}
