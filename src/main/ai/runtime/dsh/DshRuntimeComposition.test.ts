import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'

import { DshRuntimeComposition } from './DshRuntimeComposition'
import type { DshProviderInjection } from './modelInjection'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cherry-dsh-composition-'))
  directories.push(directory)
  return directory
}

function model(): DshProviderInjection {
  return {
    providerRoute: 'cherry-dsh',
    credentialRef: 'CHERRY_DSH_API_KEY',
    apiKey: 'test-key',
    api: 'openai-completions',
    baseURL: 'https://example.invalid/v1',
    modelId: 'test-model',
    input: ['text'],
    usageCapture: {
      owner: 'agent-sdk',
      credentialReceipt: { attribution: 'unknown' },
      providerId: 'test',
      providerName: 'Test',
      source: null,
      frozenModels: []
    }
  }
}

const INTERACTION = {
  sessionId: 'cherry-session',
  emit: () => undefined,
  getInteractionState: () => ({ userResponse: 'unavailable' as const }),
  getPermissionMode: () => 'default' as const,
  isDisabled: () => false,
  approvalRequiredTools: new Set<string>()
}

const MCP_TOOL: ToolDefinition = {
  name: 'mcp__cherry__search',
  description: 'Search Cherry',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  output: {
    schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false
    },
    render: (_args, value) => [{ type: 'text', text: (value as { text: string }).text }]
  },
  execute: async () => ({ text: 'ok' })
}

describe('DshRuntimeComposition', () => {
  it('installs the bounded Pi-level runtime surface without background jobs', async () => {
    const root = await temporaryDirectory()
    const composition = await DshRuntimeComposition.create({
      cwd: root,
      dshHome: path.join(root, 'dsh-home'),
      sessionRoot: path.join(root, 'sessions'),
      injection: model(),
      prompt: 'You are Cherry Studio.',
      includeHarnessIdentity: true,
      skillDirs: [path.join(root, 'skills')],
      mcpTools: [MCP_TOOL],
      permissionMode: 'default',
      interaction: INTERACTION
    })

    try {
      expect(composition.ctx.permissionPresets.names).toEqual(['default', 'acceptEdits', 'plan', 'bypassPermissions'])
      expect(composition.ctx.llm.listProviders()).toEqual([{ id: 'cherry-dsh', name: 'Test' }])
      await expect(
        composition.ctx.userQuestions.ask({ questions: [{ id: 'q', question: 'Continue?' }] })
      ).rejects.toThrow('This unattended turn cannot request tool approval')
      expect(
        composition.ctx.tools
          .schemas()
          .map((tool) => tool.name)
          .sort()
      ).toEqual([
        'ask_user_question',
        'bash',
        'edit',
        'exit_plan_mode',
        'read',
        'read_image',
        'skill',
        'subagent',
        'todo_write',
        'write'
      ])
      const handle = await composition.createOrResume({ sessionId: 'session-1', resume: false })
      expect(composition.ctx.tools.schemas(handle.agent).map((tool) => tool.name)).toContain('mcp__cherry__search')
      await handle.dispose()
    } finally {
      await composition.dispose()
    }
  })

  it('activates DSH plan mode for a newly created plan session', async () => {
    const root = await temporaryDirectory()
    const composition = await DshRuntimeComposition.create({
      cwd: root,
      dshHome: path.join(root, 'dsh-home'),
      sessionRoot: path.join(root, 'sessions'),
      injection: model(),
      prompt: 'You are Cherry Studio.',
      includeHarnessIdentity: true,
      skillDirs: [],
      mcpTools: [],
      permissionMode: 'plan',
      interaction: { ...INTERACTION, getPermissionMode: () => 'plan' as const }
    })
    try {
      const handle = await composition.createOrResume({ sessionId: 'plan-session', resume: false })
      expect(composition.ctx.planMode.get(handle.agent)).toMatchObject({ active: true })
      await handle.dispose()
    } finally {
      await composition.dispose()
    }
  })

  it('creates a fresh session when Cherry has a stale resume token but no DSH artifact', async () => {
    const root = await temporaryDirectory()
    const composition = await DshRuntimeComposition.create({
      cwd: root,
      dshHome: path.join(root, 'dsh-home'),
      sessionRoot: path.join(root, 'sessions'),
      injection: model(),
      prompt: 'You are Cherry Studio.',
      includeHarnessIdentity: true,
      skillDirs: [],
      mcpTools: [],
      permissionMode: 'default',
      interaction: INTERACTION
    })
    try {
      const handle = await composition.createOrResume({ sessionId: 'stale-resume-token', resume: true })
      expect(handle.agent.session.id).toBe('stale-resume-token')
      await handle.dispose()
    } finally {
      await composition.dispose()
    }
  })
})
