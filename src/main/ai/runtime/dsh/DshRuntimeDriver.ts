import { agentService } from '@data/services/AgentService'
import { prepareAgentSessionWorkspaceDirectory } from '@main/ai/runtime/agentSessionWorkspace'
import { DSH_BUILTIN_TOOLS } from '@shared/ai/dshBuiltinTools'
import type { Tool } from '@shared/ai/tool'
import type { AgentSessionEntity } from '@shared/data/api/schemas/agentSessions'

import type { AgentRuntimeConnectInput, AgentRuntimeConnection, AgentSessionRuntimeDriver } from '../types'
import { DshRuntimeConnection } from './DshRuntimeConnection'
import { assertDshSdkInstalled } from './dshSdk'
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
    assertDshSdkInstalled()
  }

  async listAvailableTools(_mcpIds: string[]): Promise<Tool[]> {
    return DSH_BUILTIN_TOOLS.map((tool) => ({
      id: tool.name,
      name: tool.name,
      origin: 'builtin',
      approval: tool.approval
    }))
  }

  async connect(input: AgentRuntimeConnectInput): Promise<AgentRuntimeConnection> {
    return new DshRuntimeConnection(input).start()
  }
}
