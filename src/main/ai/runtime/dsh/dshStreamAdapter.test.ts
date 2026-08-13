import { describe, expect, it } from 'vitest'

import { DSH_TRANSPORT, DshStreamAdapter } from './dshStreamAdapter'

describe('DshStreamAdapter', () => {
  it('maps a text turn into Cherry chunks', () => {
    const chunks: Array<{ type: string }> = []
    const adapter = new DshStreamAdapter({ enqueue: (chunk) => chunks.push(chunk) })
    adapter.handleSessionEvent({ type: 'turn/start', data: { turn: 1 } })
    adapter.handleSessionEvent({ type: 'step/start', data: { turn: 1, step: 1 } })
    adapter.handleSessionEvent({
      type: 'assistant/chunk',
      data: { chunk: { type: 'text-delta', text: 'hello' } }
    })
    adapter.handleSessionEvent({
      type: 'assistant/message',
      data: { usage: { input: 10, output: 2 } }
    })
    expect(chunks.map((chunk) => chunk.type)).toEqual(['text-start', 'text-delta', 'text-end'])
    expect(adapter.getUsage().totalTokens).toBe(12)
  })

  it('keeps dsh tool names and stamps transport', () => {
    const chunks: Array<Record<string, unknown>> = []
    const adapter = new DshStreamAdapter({ enqueue: (chunk) => chunks.push(chunk as Record<string, unknown>) })
    adapter.handleSessionEvent({
      type: 'tool/call',
      data: { callId: 'c1', name: 'str_replace_editor', arguments: '{"path":"a.txt"}' }
    })
    expect(chunks[0]?.toolName).toBe('str_replace_editor')
    const meta = chunks[0]?.providerMetadata as { cherry?: { transport?: string } }
    expect(meta.cherry?.transport).toBe(DSH_TRANSPORT)
  })

  it('maps packed text-chunks and assistant/message text', () => {
    const chunks: Array<{ type: string; delta?: string }> = []
    const adapter = new DshStreamAdapter({ enqueue: (chunk) => chunks.push(chunk as { type: string; delta?: string }) })
    adapter.handleSessionEvent({ type: 'step/start', data: { step: 1 } })
    adapter.handleSessionEvent({
      type: 'text-chunks',
      data: { texts: ['已生成 ', 'pelican_bike.html'] }
    })
    adapter.handleSessionEvent({
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '完成' }] } }
    })
    expect(chunks.map((chunk) => chunk.type)).toEqual(['text-start', 'text-delta', 'text-delta', 'text-end'])
    expect(
      chunks
        .filter((chunk) => chunk.type === 'text-delta')
        .map((chunk) => chunk.delta)
        .join('')
    ).toBe('已生成 pelican_bike.html')
  })

  it('closes a tool result using message.source.callId', () => {
    const chunks: Array<Record<string, unknown>> = []
    const adapter = new DshStreamAdapter({ enqueue: (chunk) => chunks.push(chunk as Record<string, unknown>) })
    adapter.handleSessionEvent({
      type: 'tool/call',
      data: { callId: 'call_00_abc', name: 'bash', arguments: '{"command":"ls"}' }
    })
    adapter.handleSessionEvent({
      type: 'tool/result',
      data: {
        message: {
          source: { kind: 'tool', callId: 'call_00_abc' },
          content: [{ type: 'tool-result', toolCallId: 'call_00_abc', content: [{ type: 'text', text: 'ok\n' }] }]
        }
      }
    })
    const output = chunks.find((chunk) => chunk.type === 'tool-output-available')
    expect(output?.toolCallId).toBe('call_00_abc')
    expect(output?.output).toBe('ok\n')
  })

  it('keeps the provider failure from a finish error chunk', () => {
    const adapter = new DshStreamAdapter({ enqueue: () => undefined })
    adapter.handleSessionEvent({ type: 'turn/start', data: { turn: 1 } })
    adapter.handleSessionEvent({
      type: 'assistant/chunk',
      data: {
        chunk: {
          type: 'finish',
          reason: { kind: 'error', failure: { message: 'DeepSeek API error (HTTP 404)', code: 'HTTP_404' } }
        }
      }
    })
    expect(adapter.getLastError()).toBe('DeepSeek API error (HTTP 404) (HTTP_404)')
  })
})
