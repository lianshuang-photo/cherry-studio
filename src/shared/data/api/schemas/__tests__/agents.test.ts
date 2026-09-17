import { CreateAgentCommandSchema } from '@shared/ipc/schemas/ai'
import { describe, expect, it } from 'vitest'

import { AgentConfigurationSchema, AgentEntitySchema, ListAgentsQuerySchema, UpdateAgentSchema } from '../agents'

describe('AgentEntitySchema', () => {
  const baseAgent = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    type: 'claude-code',
    name: 'Agent',
    description: '',
    instructions: 'You are helpful.',
    model: 'openai::gpt-4',
    orderKey: 'a0',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    modelName: null
  }

  it('requires service-populated modelName instead of defaulting it in Zod', () => {
    const { modelName, ...missingModelName } = baseAgent

    expect(AgentEntitySchema.safeParse(missingModelName).success).toBe(false)
    expect(AgentEntitySchema.parse(baseAgent).modelName).toBe(modelName)
  })

  it('does not expose outer user tags on agents', () => {
    expect(AgentEntitySchema.safeParse({ ...baseAgent, tags: [] }).success).toBe(false)
    expect(UpdateAgentSchema.safeParse({ tagIds: [] }).success).toBe(false)
    expect(ListAgentsQuerySchema.safeParse({ tagIds: ['11111111-1111-4111-8111-111111111111'] }).success).toBe(false)
  })

  it('deduplicates disabledTools at the API parse boundary', () => {
    expect(UpdateAgentSchema.parse({ disabledTools: ['Read', 'Read'] }).disabledTools).toEqual(['Read'])
  })

  it('does not accept create-only skillIds on update', () => {
    expect(UpdateAgentSchema.safeParse({ skillIds: ['skill-b'] }).success).toBe(false)
  })

  it('validates the persisted agent reasoning effort', () => {
    expect(AgentConfigurationSchema.parse({ reasoning_effort: 'high' }).reasoning_effort).toBe('high')
    expect(AgentConfigurationSchema.safeParse({ reasoning_effort: 'invalid' }).success).toBe(false)
  })

  it('accepts first-level configuration patches and preserves explicit removals', () => {
    expect(UpdateAgentSchema.parse({ configuration: { reasoning_effort: 'high' } }).configuration).toEqual({
      reasoning_effort: 'high'
    })

    const parsed = UpdateAgentSchema.parse({ configuration: { max_turns: undefined } })
    expect(parsed.configuration).toHaveProperty('max_turns', undefined)
  })

  it('validates and deduplicates knowledgeBaseIds at the API parse boundary', () => {
    expect(UpdateAgentSchema.parse({ knowledgeBaseIds: ['kb-b', 'kb-b'] }).knowledgeBaseIds).toEqual(['kb-b'])
    expect(UpdateAgentSchema.parse({ knowledgeBaseIds: [] }).knowledgeBaseIds).toEqual([])
    expect(UpdateAgentSchema.safeParse({ knowledgeBaseIds: [''] }).success).toBe(false)
  })

  it('deduplicates update skillUpdates at the API parse boundary', () => {
    expect(
      UpdateAgentSchema.parse({
        skillUpdates: [
          { skillId: 'skill-a', isEnabled: true },
          { skillId: 'skill-b', isEnabled: true },
          { skillId: 'skill-a', isEnabled: false }
        ]
      }).skillUpdates
    ).toEqual([
      { skillId: 'skill-a', isEnabled: false },
      { skillId: 'skill-b', isEnabled: true }
    ])
  })
})

describe('Agent environment variables at save boundaries', () => {
  const createBase = { type: 'claude-code', name: 'Agent', model: 'openai::gpt-4' }

  describe.each([
    ['configuration', (configuration: unknown) => AgentConfigurationSchema.safeParse(configuration)],
    ['create', (configuration: unknown) => CreateAgentCommandSchema.safeParse({ ...createBase, configuration })],
    ['update', (configuration: unknown) => UpdateAgentSchema.safeParse({ configuration })]
  ] as const)('%s', (_name, parse) => {
    it.each([
      { 'BAD\u0000NAME': 'private-value' },
      { TOKEN: 'private\u0000value' },
      { TOKEN: 'private-value\u0000' },
      { TOKEN: '\u0000private-value' }
    ])('rejects null bytes without exposing values: %j', (envVars) => {
      const result = parse({ env_vars: envVars })
      expect(result.success).toBe(false)
      if (result.success) throw new Error('Expected invalid environment variables to be rejected')
      expect(result.error.message).toContain('Environment variable names and values must not contain null bytes')
      expect(result.error.message).not.toContain('private')
    })

    it.each([
      {},
      { env_vars: undefined },
      { env_vars: {} },
      { env_vars: { TOKEN: 'normal', EMPTY: '', UNICODE: '中文', MULTILINE: 'a\nb', EQUALS: 'a=b' } },
      { env_vars: { TOKEN: 'normal' }, future_setting: { enabled: true } }
    ])('preserves valid configuration: %j', (configuration) => {
      const result = parse(configuration)
      expect(result.success).toBe(true)
      if (!result.success) throw result.error
      const data = _name === 'configuration' ? result.data : result.data.configuration
      expect(data).toEqual(configuration)
    })
  })

  it('keeps configuration optional on create and update', () => {
    expect(CreateAgentCommandSchema.safeParse(createBase).success).toBe(true)
    expect(UpdateAgentSchema.parse({})).toEqual({})
  })
})
