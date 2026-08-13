import { application } from '@application'
import { agentService } from '@data/services/AgentService'
import { agentSessionService } from '@data/services/AgentSessionService'
import { mcpServerService } from '@data/services/McpServerService'
import { prepareAgentSessionWorkspaceDirectory } from '@main/ai/runtime/agentSessionWorkspace'
import { DSH_BUILTIN_TOOLS } from '@shared/ai/dshBuiltinTools'
import type { Tool } from '@shared/ai/tool'
import type { AgentSessionEntity } from '@shared/data/api/schemas/agentSessions'

import type { AgentRuntimeConnectInput, AgentRuntimeConnection, AgentSessionRuntimeDriver } from '../types'
import { buildDshMcpToolName } from './dshMcpToolAdapter'
import { DshRuntimeConnection } from './DshRuntimeConnection'
import { assertDshProviderUsable } from './modelInjection'

export class DshRuntimeDriver implements AgentSessionRuntimeDriver {
  readonly type = 'dsh'
  readonly capabilities = ['agent-session'] as const

  async validateSession(session: AgentSessionEntity): Promise<void> {
    const cwd = session.workspace?.path
    if (!cwd) {
      throw new Error(`dsh agent session ${session.id} has no workspace configured`)
    }
    if (!session.agentId) {
      throw new Error(`dsh agent session ${session.id} has no agent`)
    }
    const agent = agentService.getAgent(session.agentId)
    if (!agent?.model) {
      throw new Error(`dsh agent ${session.agentId} has no model configured`)
    }
    await prepareAgentSessionWorkspaceDirectory(session)
    await assertDshProviderUsable(agent.model)
  }

  async listAvailableTools(mcpIds: string[]): Promise<Tool[]> {
    const builtins: Tool[] = DSH_BUILTIN_TOOLS.map((tool) => ({
      id: tool.name,
      name: tool.name,
      origin: 'builtin',
      approval: tool.approval
    }))
    const catalog = application.get('McpCatalogService')
    const mcpTools: Tool[] = mcpIds.flatMap((idOrName) => {
      const server = mcpServerService.findByIdOrName(idOrName)
      if (!server) return []
      return catalog.listTools(server.id, { includeDisabled: false }).map((tool) => ({
        id: buildDshMcpToolName(server.name, tool.name),
        name: tool.name,
        origin: 'mcp' as const,
        approval: 'prompt' as const,
        sourceId: server.id,
        sourceName: server.name
      }))
    })
    return [...builtins, ...mcpTools]
  }

  async connect(input: AgentRuntimeConnectInput): Promise<AgentRuntimeConnection> {
    // Warm priming skips dispatch validation, so materialize the workspace before
    // DSH creates its sandbox with this cwd.
    const session = agentSessionService.getById(input.sessionId)
    if (session) await prepareAgentSessionWorkspaceDirectory(session)
    return new DshRuntimeConnection(input).start()
  }
}
