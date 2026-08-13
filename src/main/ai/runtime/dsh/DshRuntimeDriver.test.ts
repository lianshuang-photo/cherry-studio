import { DSH_BUILTIN_TOOLS } from '@shared/ai/dshBuiltinTools'
import type { AgentSessionEntity } from '@shared/data/api/schemas/agentSessions'
import type { McpServer } from '@shared/data/types/mcpServer'
import type { McpTool } from '@shared/types/mcp'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getAgent: vi.fn(),
  getSession: vi.fn(),
  findByIdOrName: vi.fn(),
  listTools: vi.fn(),
  prepareWorkspace: vi.fn(),
  assertProviderUsable: vi.fn(),
  startConnection: vi.fn()
}))

vi.mock('@data/services/AgentService', () => ({ agentService: { getAgent: mocks.getAgent } }))
vi.mock('@data/services/AgentSessionService', () => ({ agentSessionService: { getById: mocks.getSession } }))
vi.mock('@data/services/McpServerService', () => ({
  mcpServerService: { findByIdOrName: mocks.findByIdOrName }
}))
vi.mock('@application', () => ({
  application: {
    get: (name: string) => {
      if (name === 'McpCatalogService') return { listTools: mocks.listTools }
      throw new Error(`unexpected service ${name}`)
    }
  }
}))
vi.mock('@main/ai/runtime/agentSessionWorkspace', () => ({
  prepareAgentSessionWorkspaceDirectory: mocks.prepareWorkspace
}))
vi.mock('./modelInjection', () => ({ assertDshProviderUsable: mocks.assertProviderUsable }))
vi.mock('./DshRuntimeConnection', () => ({
  DshRuntimeConnection: vi.fn().mockImplementation(() => ({ start: mocks.startConnection }))
}))

const { DshRuntimeDriver } = await import('./DshRuntimeDriver')
const { buildDshMcpToolName } = await import('./dshMcpToolAdapter')

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listTools.mockReturnValue([])
  mocks.prepareWorkspace.mockResolvedValue(undefined)
  mocks.assertProviderUsable.mockResolvedValue(undefined)
  mocks.startConnection.mockResolvedValue({ connection: 'dsh' })
})

describe('DshRuntimeDriver.validateSession', () => {
  it('validates a Cherry model after materializing its system workspace without a Python SDK', async () => {
    const session = {
      id: 'session-1',
      agentId: 'agent-1',
      workspace: { path: '/data/Agents/system/2026-08-14/session-1', type: 'system' }
    } as AgentSessionEntity
    mocks.getAgent.mockReturnValue({ model: 'provider::model' })

    await new DshRuntimeDriver().validateSession(session)

    expect(mocks.prepareWorkspace).toHaveBeenCalledWith(session)
    expect(mocks.assertProviderUsable).toHaveBeenCalledWith('provider::model')
    expect(mocks.prepareWorkspace.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.assertProviderUsable.mock.invocationCallOrder[0]
    )
  })

  it('materializes a new system workspace before an idle-prime connection starts', async () => {
    const session = {
      id: 'session-1',
      agentId: 'agent-1',
      workspace: { path: '/data/Agents/system/2026-08-14/session-1', type: 'system' }
    } as AgentSessionEntity
    mocks.getSession.mockReturnValue(session)

    await new DshRuntimeDriver().connect({
      sessionId: session.id,
      agentId: 'agent-1',
      modelId: 'provider::model'
    })

    expect(mocks.prepareWorkspace).toHaveBeenCalledWith(session)
    expect(mocks.prepareWorkspace.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.startConnection.mock.invocationCallOrder[0]
    )
  })

  it('does not start DSH when workspace materialization fails during idle priming', async () => {
    mocks.getSession.mockReturnValue({
      id: 'session-1',
      agentId: 'agent-1',
      workspace: { path: '/data/Agents/system/2026-08-14/session-1', type: 'system' }
    } as AgentSessionEntity)
    mocks.prepareWorkspace.mockRejectedValue(new Error('ENOENT: workspace not ready'))

    await expect(
      new DshRuntimeDriver().connect({ sessionId: 'session-1', agentId: 'agent-1', modelId: 'provider::model' })
    ).rejects.toThrow('ENOENT: workspace not ready')

    expect(mocks.startConnection).not.toHaveBeenCalled()
  })
})

describe('DshRuntimeDriver.listAvailableTools', () => {
  it('returns the complete native DSH builtin catalog when MCP is not selected', async () => {
    const tools = await new DshRuntimeDriver().listAvailableTools([])

    expect(tools).toEqual(
      DSH_BUILTIN_TOOLS.map((tool) => ({
        id: tool.name,
        name: tool.name,
        origin: 'builtin',
        approval: tool.approval
      }))
    )
    expect(mocks.findByIdOrName).not.toHaveBeenCalled()
  })

  it('appends prompt-gated MCP catalog tools with their stable DSH identity', async () => {
    mocks.findByIdOrName.mockReturnValue({ id: 'srv-1', name: 'github' } as McpServer)
    mocks.listTools.mockReturnValue([{ name: 'search_issues', description: 'Search issues' } as McpTool])

    const tools = await new DshRuntimeDriver().listAvailableTools(['srv-1'])

    expect(mocks.listTools).toHaveBeenCalledWith('srv-1', { includeDisabled: false })
    expect(tools.slice(0, DSH_BUILTIN_TOOLS.length)).toEqual(
      DSH_BUILTIN_TOOLS.map((tool) => ({
        id: tool.name,
        name: tool.name,
        origin: 'builtin',
        approval: tool.approval
      }))
    )
    expect(tools.slice(DSH_BUILTIN_TOOLS.length)).toEqual([
      {
        id: buildDshMcpToolName('github', 'search_issues'),
        name: 'search_issues',
        origin: 'mcp',
        approval: 'prompt',
        sourceId: 'srv-1',
        sourceName: 'github'
      }
    ])
  })

  it('skips selected MCP servers that are no longer available', async () => {
    mocks.findByIdOrName.mockReturnValue(null)

    const tools = await new DshRuntimeDriver().listAvailableTools(['gone'])

    expect(tools).toHaveLength(DSH_BUILTIN_TOOLS.length)
    expect(tools.every((tool) => tool.origin === 'builtin')).toBe(true)
    expect(mocks.listTools).not.toHaveBeenCalled()
  })
})
