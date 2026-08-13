import { createHash } from 'node:crypto'

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonSchemaNode, JsonValue } from '@deepseek-ai/dsh-tools'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import { loggerService } from '@logger'
import type { AgentMcpServer } from '@main/ai/runtime/agentMcpServers'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { type CallToolResult, ListToolsResultSchema, type Tool } from '@modelcontextprotocol/sdk/types.js'

const logger = loggerService.withContext('DshMcpToolAdapter')
const MAX_PUBLIC_NAME_LENGTH = 64
const HASH_LENGTH = 12

class DshMcpToolIdentityError extends Error {}

export interface DshMcpToolBridge {
  tools: ToolDefinition[]
  close(): Promise<void>
}

/** Produce a stable DSH-safe name without ever deriving the MCP wire name from it. */
export function buildDshMcpToolName(serverName: string, toolName: string): string {
  const wireName = `mcp__${serverName}__${toolName}`
  const normalized = wireName.replace(/[^A-Za-z0-9_-]/g, '_')
  if (normalized === wireName && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized

  const hash = createHash('sha256').update(`${serverName}\0${toolName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}

/** Adapt the complete Cherry MCP server set to native DSH tool definitions over in-memory transports. */
export async function buildDshMcpToolDefinitions(servers: Record<string, AgentMcpServer>): Promise<DshMcpToolBridge> {
  const clients: Client[] = []
  const tools: ToolDefinition[] = []

  for (const [serverId, server] of Object.entries(servers)) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: `cherry-dsh-${serverId}`, version: '1.0.0' }, { capabilities: {} })
    try {
      await server.instance.connect(serverTransport)
      await client.connect(clientTransport)
      const serverTools = (await listAllTools(client)).map((tool) => toDshToolDefinition(server.name, tool, client))
      const existingNames = new Set(tools.map((tool) => tool.name))
      const serverNames = new Set<string>()
      for (const tool of serverTools) {
        if (existingNames.has(tool.name) || serverNames.has(tool.name)) {
          throw new DshMcpToolIdentityError(`Duplicate DSH MCP tool name: ${tool.name}`)
        }
        serverNames.add(tool.name)
      }
      clients.push(client)
      tools.push(...serverTools)
    } catch (error) {
      await client.close().catch(() => undefined)
      if (error instanceof DshMcpToolIdentityError) {
        await Promise.allSettled(clients.map((connected) => connected.close()))
        throw error
      }
      logger.warn('Skipping unavailable MCP server for DSH session', { serverId, error })
    }
  }

  return {
    tools,
    async close() {
      await Promise.allSettled(clients.map((client) => client.close()))
    }
  }
}

async function listAllTools(client: Client): Promise<Tool[]> {
  const tools: Tool[] = []
  let cursor: string | undefined
  do {
    const response = await client.request(
      { method: 'tools/list', params: cursor ? { cursor } : {} },
      ListToolsResultSchema
    )
    tools.push(...response.tools)
    cursor = response.nextCursor
  } while (cursor)
  return tools
}

function toDshToolDefinition(serverName: string, tool: Tool, client: Client): ToolDefinition {
  return {
    name: buildDshMcpToolName(serverName, tool.name),
    description: tool.description ?? '',
    parameters: normalizeInputSchema(tool.inputSchema),
    output: {
      schema: {
        type: 'object',
        properties: {
          content: { type: 'array', items: {} },
          structuredContent: {}
        },
        required: ['content'],
        additionalProperties: false
      },
      render(_args, value) {
        const result = value as McpToolResult
        return [{ type: 'text', text: renderMcpContent(result.content, tool.name) }]
      }
    },
    async execute(args, exec) {
      if (tool.execution?.taskSupport === 'required') {
        throw new Error(`MCP tool "${tool.name}" requires task-based execution, which DSH does not support`)
      }
      const result = (await client.callTool({ name: tool.name, arguments: toArgumentObject(args) }, undefined, {
        signal: exec.signal
      })) as CallToolResult
      const content = normalizeContent(result.content)
      const text = renderMcpContent(content, tool.name)
      if (result.isError) throw new Error(text)
      return result.structuredContent === undefined
        ? { content }
        : { content, structuredContent: toJsonValue(result.structuredContent) }
    }
  }
}

type McpToolResult = {
  content: JsonValue[]
  structuredContent?: JsonValue
}

function toArgumentObject(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
}

function normalizeContent(content: CallToolResult['content']): JsonValue[] {
  return content.map((part) => toJsonValue(part))
}

function toJsonValue(value: unknown): JsonValue {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) return '[MCP returned non-JSON content]'
  try {
    return JSON.parse(serialized) as JsonValue
  } catch {
    return '[MCP returned non-JSON content]'
  }
}

function renderMcpContent(content: JsonValue[], toolName: string): string {
  const parts = content.map(renderMcpContentBlock).filter((part): part is string => part !== '')
  return parts.join('\n') || `(${toolName} returned no text content)`
}

function renderMcpContentBlock(value: JsonValue): string {
  if (!isRecord(value)) return '[unsupported MCP content]'
  switch (value.type) {
    case 'text':
      return typeof value.text === 'string' ? value.text : '[MCP text content unavailable]'
    case 'image':
      return `[image content (${stringOrUnknown(value.mimeType)}); preserved in MCP result]`
    case 'audio':
      return `[audio content (${stringOrUnknown(value.mimeType)}); preserved in MCP result]`
    case 'resource':
      return renderEmbeddedResource(value.resource)
    case 'resource_link':
      return `[resource: ${stringOrUnknown(value.uri)}${typeof value.mimeType === 'string' ? ` (${value.mimeType})` : ''}]`
    default:
      return `[unsupported MCP content type: ${typeof value.type === 'string' ? value.type : 'unknown'}]`
  }
}

function renderEmbeddedResource(resource: JsonValue | undefined): string {
  if (!isRecord(resource)) return '[resource content unavailable]'
  if (typeof resource.text === 'string') return resource.text
  return `[resource: ${stringOrUnknown(resource.uri)}${typeof resource.mimeType === 'string' ? ` (${resource.mimeType})` : ''}; content preserved in MCP result]`
}

function stringOrUnknown(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : 'unknown'
}

function normalizeInputSchema(schema: unknown): Record<string, unknown> {
  const normalized = normalizeSchemaNode(schema)
  const objectSchema =
    normalized?.type === 'object' ? normalized : { type: 'object', properties: {}, additionalProperties: true }
  try {
    assertSupportedJsonSchema(objectSchema)
    return objectSchema as Record<string, unknown>
  } catch {
    return { type: 'object', properties: {}, additionalProperties: true }
  }
}

function normalizeSchemaNode(value: unknown): JsonSchemaNode | undefined {
  if (!isRecord(value)) return undefined
  const type = normalizeSchemaType(value.type)
  const node: Record<string, unknown> = {}
  if (type) Object.assign(node, type)
  for (const key of ['description', 'title'] as const) {
    if (typeof value[key] === 'string') node[key] = value[key]
  }
  for (const key of ['default', 'examples'] as const) {
    if (value[key] !== undefined) node[key] = toJsonValue(value[key])
  }
  if (isScalar(value.const)) node.const = value.const
  if (Array.isArray(value.enum) && value.enum.every(isScalar)) node.enum = value.enum

  const properties = isRecord(value.properties)
    ? Object.fromEntries(
        Object.entries(value.properties)
          .map(([name, child]) => [name, normalizeSchemaNode(child)] as const)
          .filter((entry): entry is [string, JsonSchemaNode] => entry[1] !== undefined)
      )
    : undefined
  if (properties) {
    node.type = 'object'
    node.properties = properties
    if (Array.isArray(value.required))
      node.required = value.required.filter((name): name is string => typeof name === 'string' && name in properties)
    if (typeof value.additionalProperties === 'boolean') node.additionalProperties = value.additionalProperties
  }

  const items = normalizeSchemaNode(value.items)
  if (items) {
    node.type = 'array'
    node.items = items
  }
  if (!properties && !items && Array.isArray(value.oneOf)) {
    const branches = value.oneOf
      .map(normalizeSchemaNode)
      .filter((branch): branch is JsonSchemaNode => branch !== undefined)
    if (branches.length >= 2) node.oneOf = branches
  }
  return node as JsonSchemaNode
}

function normalizeSchemaType(value: unknown): Pick<JsonSchemaNode, 'type' | 'oneOf'> | undefined {
  if (isJsonSchemaType(value)) return { type: value }
  if (!Array.isArray(value)) return undefined
  const types = [...new Set(value.filter(isJsonSchemaType))]
  return types.length >= 2 ? { oneOf: types.map((type) => ({ type })) } : types[0] ? { type: types[0] } : undefined
}

function isJsonSchemaType(value: unknown): value is NonNullable<JsonSchemaNode['type']> {
  return ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(value as string)
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
