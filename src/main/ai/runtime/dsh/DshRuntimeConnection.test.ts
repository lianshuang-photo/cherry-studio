import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentRuntimeConnectInput, AgentRuntimeEvent } from '@main/ai/runtime/types'
import { describe, expect, it, vi } from 'vitest'

import { DshRuntimeConnection } from './DshRuntimeConnection'

type TestableConnection = {
  turnActive: boolean
  contextWindow: number
  modelId: string
  agent: Agent
  composition: {
    ctx: { tokenMeter: { measure: (session: unknown) => { totalTokens: number } } }
    dispose: () => Promise<void>
  }
  finishTurn(error?: unknown): void
  handleSessionEvent(event: unknown): void
  buildInteractionBridge(
    disabledTools: readonly string[] | undefined,
    permissionMode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'
  ): { isDisabled(toolName: string): boolean }
}

async function collect(connection: DshRuntimeConnection): Promise<AgentRuntimeEvent[]> {
  const events: AgentRuntimeEvent[] = []
  for await (const event of connection.events) events.push(event)
  return events
}

describe('DshRuntimeConnection turn lifecycle', () => {
  it('honors legacy capitalized builtin tool disable ids', () => {
    const connection = new DshRuntimeConnection({ sessionId: 'session-1' } as AgentRuntimeConnectInput)
    const bridge = (connection as unknown as TestableConnection).buildInteractionBridge(['Bash', 'Write'], 'default')

    expect(bridge.isDisabled('bash')).toBe(true)
    expect(bridge.isDisabled('write')).toBe(true)
  })

  it('emits context usage before exactly one successful terminal', async () => {
    const connection = new DshRuntimeConnection({ sessionId: 'session-1' } as AgentRuntimeConnectInput)
    const internal = connection as unknown as TestableConnection
    internal.turnActive = true
    internal.contextWindow = 1_000
    internal.modelId = 'test-model'
    internal.agent = {
      session: {},
      cancel: vi.fn()
    } as unknown as Agent
    internal.composition = {
      ctx: { tokenMeter: { measure: () => ({ totalTokens: 250 }) } },
      dispose: () => Promise.resolve()
    }

    internal.finishTurn()
    internal.finishTurn()
    await connection.close()

    const events = await collect(connection)
    expect(events).toEqual([
      {
        type: 'context-usage',
        usage: {
          categories: [],
          totalTokens: 250,
          maxTokens: 1_000,
          percentage: 25,
          model: 'test-model'
        }
      },
      { type: 'turn-complete' }
    ])
  })

  it('maps a bounded DSH retry to Cherry retry status without changing its fields', async () => {
    const connection = new DshRuntimeConnection({ sessionId: 'session-1' } as AgentRuntimeConnectInput)
    const internal = connection as unknown as TestableConnection
    internal.turnActive = true

    internal.handleSessionEvent({
      type: 'llm/retry',
      data: {
        retryId: 'retry-1',
        mode: 'normal',
        retry: 2,
        maxRetries: 3,
        delayMs: 1_250,
        failure: { code: 'HTTP_429', status: 429 }
      }
    })
    await connection.close()

    await expect(collect(connection)).resolves.toEqual([
      {
        type: 'api-retry',
        retry: {
          attempt: 2,
          maxRetries: 3,
          retryDelayMs: 1_250,
          errorStatus: 429,
          errorCategory: 'HTTP_429'
        }
      }
    ])
  })

  it('does not fabricate a bounded retry status for DSH always mode', async () => {
    const connection = new DshRuntimeConnection({ sessionId: 'session-1' } as AgentRuntimeConnectInput)
    const internal = connection as unknown as TestableConnection
    internal.turnActive = true

    internal.handleSessionEvent({
      type: 'llm/retry',
      data: { retryId: 'retry-1', mode: 'always', retry: 2, delayMs: 1_250, failure: { code: 'HTTP_429' } }
    })
    await connection.close()

    await expect(collect(connection)).resolves.toEqual([])
  })
})
