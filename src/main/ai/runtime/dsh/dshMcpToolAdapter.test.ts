import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool
} from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }
}))

const { buildDshMcpToolDefinitions, buildDshMcpToolName } = await import('./dshMcpToolAdapter')

function createServer(
  tools: Tool[],
  call: (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<CallToolResult>
): McpServer {
  const server = new McpServer({ name: 'test', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
    call(request.params.name, request.params.arguments ?? {}, extra.signal)
  )
  return server
}

function tool(name: string, inputSchema: Tool['inputSchema'] = { type: 'object', properties: {} }): Tool {
  return { name, description: `${name} desc`, inputSchema }
}

describe('buildDshMcpToolDefinitions', () => {
  it('uses deterministic, collision-resistant DSH tool names within the protocol limit', () => {
    const prefix = 'tool_with_a_shared_prefix_'.repeat(4)
    const first = buildDshMcpToolName('server', `${prefix}first`)
    const second = buildDshMcpToolName('server', `${prefix}second`)

    expect(first).not.toBe(second)
    expect(first).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(second).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
  })

  it('adapts every supplied Cherry MCP server and normalizes unsupported input keywords', async () => {
    const server = createServer(
      [
        tool('search', {
          type: 'object',
          properties: { query: { type: 'string', minLength: 1, format: 'uri' } },
          required: ['query'],
          additionalProperties: false
        })
      ],
      async () => ({ content: [{ type: 'text', text: 'ok' }] })
    )

    const bridge = await buildDshMcpToolDefinitions({ search: { name: 'search', instance: server } })

    expect(bridge.tools.map((definition) => definition.name)).toEqual(['mcp__search__search'])
    expect(bridge.tools[0].parameters).toEqual({
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false
    })
    expect(() => assertSupportedJsonSchema(bridge.tools[0].parameters)).not.toThrow()
    await bridge.close()
  })

  it('drains every MCP tools/list page before registering definitions', async () => {
    const server = new McpServer({ name: 'paginated', version: '1.0.0' }, { capabilities: { tools: {} } })
    server.server.setRequestHandler(ListToolsRequestSchema, async (request) =>
      request.params?.cursor === 'next' ? { tools: [tool('second')] } : { tools: [tool('first')], nextCursor: 'next' }
    )
    server.server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [] }))

    const bridge = await buildDshMcpToolDefinitions({ paginated: { name: 'paginated', instance: server } })

    expect(bridge.tools.map((definition) => definition.name)).toEqual([
      'mcp__paginated__first',
      'mcp__paginated__second'
    ])
    await bridge.close()
  })

  it('proxies calls with cancellation and preserves MCP content as canonical JSON', async () => {
    const call = vi.fn(async () => ({
      content: [
        { type: 'text' as const, text: 'ok' },
        { type: 'image' as const, data: 'QkFTRTY0', mimeType: 'image/png' },
        { type: 'audio' as const, data: 'QVVESU8=', mimeType: 'audio/wav' },
        { type: 'resource' as const, resource: { uri: 'file:///doc', text: 'body' } },
        { type: 'resource_link' as const, uri: 'file:///linked', name: 'linked' }
      ],
      structuredContent: { total: 3 }
    }))
    const server = createServer([tool('run')], call)
    const bridge = await buildDshMcpToolDefinitions({ server: { name: 'server', instance: server } })

    const result = await bridge.tools[0].execute({ value: 'x' }, { signal: new AbortController().signal } as never)

    expect(call).toHaveBeenCalledWith('run', { value: 'x' }, expect.any(AbortSignal))
    expect(result).toEqual({
      content: [
        { type: 'text', text: 'ok' },
        { type: 'image', data: 'QkFTRTY0', mimeType: 'image/png' },
        { type: 'audio', data: 'QVVESU8=', mimeType: 'audio/wav' },
        { type: 'resource', resource: { uri: 'file:///doc', text: 'body' } },
        { type: 'resource_link', uri: 'file:///linked', name: 'linked' }
      ],
      structuredContent: { total: 3 }
    })
    expect(bridge.tools[0].output.render({}, result as never)).toEqual([
      {
        type: 'text',
        text: 'ok\n[image content (image/png); preserved in MCP result]\n[audio content (audio/wav); preserved in MCP result]\nbody\n[resource: file:///linked]'
      }
    ])
    await bridge.close()
  })

  it('throws MCP soft errors and closes every connected client', async () => {
    const first = createServer([tool('fail')], async () => ({
      content: [{ type: 'text', text: 'MCP failed' }],
      isError: true
    }))
    const second = createServer([], async () => ({ content: [] }))
    const firstClosed = vi.fn()
    const secondClosed = vi.fn()
    first.server.onclose = firstClosed
    second.server.onclose = secondClosed
    const bridge = await buildDshMcpToolDefinitions({
      first: { name: 'first', instance: first },
      second: { name: 'second', instance: second }
    })

    await expect(bridge.tools[0].execute({}, { signal: new AbortController().signal } as never)).rejects.toThrow(
      'MCP failed'
    )
    await bridge.close()

    expect(firstClosed).toHaveBeenCalledOnce()
    expect(secondClosed).toHaveBeenCalledOnce()
  })

  it('fails closed when two MCP identities normalize to the same public name', async () => {
    const duplicate = createServer([tool('same'), tool('same')], async () => ({ content: [] }))

    await expect(buildDshMcpToolDefinitions({ duplicate: { name: 'duplicate', instance: duplicate } })).rejects.toThrow(
      'Duplicate DSH MCP tool name: mcp__duplicate__same'
    )
  })
})
