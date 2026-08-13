import { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  register: vi.fn()
}))

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }
}))
vi.mock('@main/ai/runtime/toolApproval/ToolApprovalRegistry', () => ({
  toolApprovalRegistry: { register: mocks.register, dispatch: mocks.dispatch }
}))

const { installDshInteractionBridge } = await import('./DshInteractionBridge')

const allow = (): Promise<PreToolDecision> => Promise.resolve({ kind: 'allow' })
const question = {
  id: 'deploy',
  question: 'How should I deploy?',
  header: 'Deploy',
  options: [{ label: 'Preview' }, { label: 'Production' }]
}

afterEach(() => {
  vi.restoreAllMocks()
  mocks.register.mockReset()
  mocks.register.mockImplementation(() => true)
  mocks.dispatch.mockReset()
})

async function createBridge(overrides: Partial<Parameters<typeof installDshInteractionBridge>[1]> = {}) {
  mocks.register.mockImplementation(() => true)
  const ctx = new Context()
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(ApprovalService)
  const emitted: any[] = []
  const options = {
    sessionId: 'session-1',
    emit: (event: unknown) => emitted.push(event),
    getInteractionState: () => ({ userResponse: 'stream' as const }),
    getPermissionMode: () => 'default' as const,
    isDisabled: () => false,
    approvalRequiredTools: new Set<string>(),
    ...overrides
  }
  const dispose = installDshInteractionBridge(ctx, options)
  return { ctx, emitted, dispose }
}

function preExecute(
  ctx: Context,
  name: string,
  arguments_: Record<string, unknown> = {},
  signal = new AbortController().signal
) {
  return ctx.waterfall(
    'tools/pre-execute',
    { name, callId: `call-${name}`, arguments: arguments_, signal } as never,
    allow
  )
}

describe('DshInteractionBridge', () => {
  it('denies disabled tools before any user approval in every permission mode', async () => {
    const { ctx, emitted, dispose } = await createBridge({
      getPermissionMode: () => 'bypassPermissions',
      isDisabled: (name) => name === 'bash'
    })

    await expect(preExecute(ctx, 'bash', { command: 'ls' })).resolves.toEqual({
      kind: 'deny',
      reason: 'Tool "bash" is disabled for this agent.'
    })
    expect(emitted).toEqual([])
    dispose()
  })

  it('maps default and acceptEdits policy to native DSH pre-execute decisions', async () => {
    const defaultBridge = await createBridge()
    const defaultPending = preExecute(defaultBridge.ctx, 'bash', { command: 'ls' })
    await vi.waitFor(() => expect(defaultBridge.emitted).toHaveLength(1))
    expect(defaultBridge.emitted[0].request).toMatchObject({
      toolName: 'bash',
      toolCallId: 'call-bash',
      presentation: 'stream',
      input: { command: 'ls' }
    })
    mocks.register.mock.calls[0][0].resolve({ approved: true })
    await expect(defaultPending).resolves.toEqual({ kind: 'allow' })
    defaultBridge.dispose()

    const editsBridge = await createBridge({ getPermissionMode: () => 'acceptEdits' })
    await expect(preExecute(editsBridge.ctx, 'write', { path: 'a.txt', content: 'ok' })).resolves.toEqual({
      kind: 'allow'
    })
    expect(editsBridge.emitted).toEqual([])
    editsBridge.dispose()
  })

  it('fails closed without a renderer and plan mode blocks mutation', async () => {
    const unattended = await createBridge({ getInteractionState: () => ({ userResponse: 'unavailable' }) })
    await expect(preExecute(unattended.ctx, 'bash', { command: 'ls' })).resolves.toEqual({
      kind: 'deny',
      reason: 'This unattended turn cannot request tool approval. Retry interactively.'
    })
    expect(unattended.emitted).toEqual([])
    unattended.dispose()

    const plan = await createBridge({ getPermissionMode: () => 'plan' })
    await expect(preExecute(plan.ctx, 'write', { path: 'a.txt', content: 'ok' })).resolves.toEqual({
      kind: 'deny',
      reason: 'Tool "write" is unavailable while plan mode is active.'
    })
    plan.dispose()
  })

  it('allows ordinary bypass calls but retains explicitly sensitive Cherry tools', async () => {
    const ordinary = await createBridge({ getPermissionMode: () => 'bypassPermissions' })
    await expect(preExecute(ordinary.ctx, 'bash', { command: 'rm -rf ignored' })).resolves.toEqual({ kind: 'allow' })
    ordinary.dispose()

    const sensitive = await createBridge({
      getPermissionMode: () => 'bypassPermissions',
      approvalRequiredTools: new Set(['mcp__cherry-tools__kb_manage'])
    })
    const pending = preExecute(sensitive.ctx, 'mcp__cherry-tools__kb_manage')
    await vi.waitFor(() => expect(sensitive.emitted).toHaveLength(1))
    expect(sensitive.emitted[0].request.toolName).toBe('mcp__cherry-tools__kb_manage')
    mocks.register.mock.calls[0][0].resolve({ approved: false })
    await expect(pending).resolves.toMatchObject({ kind: 'deny' })
    sensitive.dispose()
  })

  it('bridges DSH native sandbox approval requests through Cherry approval cards', async () => {
    const bridge = await createBridge()
    const pending = bridge.ctx.waterfall(
      'approval/request',
      { toolName: 'bash', callId: 'sandbox-call', signal: new AbortController().signal } as never,
      () => Promise.resolve('unavailable' as const)
    )
    await vi.waitFor(() => expect(bridge.emitted).toHaveLength(1))
    expect(bridge.emitted[0].request).toMatchObject({ toolName: 'bash', toolCallId: 'sandbox-call', input: {} })
    mocks.register.mock.calls[0][0].resolve({ approved: true })
    await expect(pending).resolves.toBe('allowed-once')
    bridge.dispose()
  })

  it('converts AskUserQuestion answers and routes plan review through the existing composer contract', async () => {
    const bridge = await createBridge()
    const questionSignal = new AbortController().signal
    await expect(
      preExecute(bridge.ctx, 'ask_user_question', { questions: [question] }, questionSignal)
    ).resolves.toEqual({
      kind: 'allow'
    })
    const pending = bridge.ctx.userQuestions.ask({ questions: [question], signal: questionSignal })
    await vi.waitFor(() => expect(bridge.emitted).toHaveLength(1))
    const approval = bridge.emitted[0].request
    expect(approval).toMatchObject({
      toolName: 'AskUserQuestion',
      toolCallId: 'call-ask_user_question',
      input: { questions: [{ question: 'How should I deploy?', header: 'Deploy', multiSelect: false }] }
    })
    const resolve = mocks.register.mock.calls[0][0].resolve
    resolve({ approved: true, updatedInput: { answers: { 'How should I deploy?': 'Production' } } })
    await expect(pending).resolves.toEqual({ answers: [{ id: 'deploy', selected: ['Production'] }] })
    bridge.dispose()
  })

  it('keeps a DSH plan review visible and returns its answer to the original question id', async () => {
    const bridge = await createBridge()
    const plan = {
      id: 'review',
      question: 'Approve this plan?',
      detail: '# Plan\n\n1. Ship it',
      options: [{ label: 'Approve' }, { label: 'Revise' }],
      intent: { kind: 'plan-review' as const, approve: 'Approve' }
    }
    const pending = bridge.ctx.userQuestions.ask({ questions: [plan] })
    await vi.waitFor(() => expect(bridge.emitted).toHaveLength(1))
    expect(bridge.emitted[0].request.input).toMatchObject({
      questions: [{ question: 'Approve this plan?\n\n# Plan\n\n1. Ship it' }]
    })
    mocks.register.mock.calls[0][0].resolve({
      approved: true,
      updatedInput: { answers: { 'Approve this plan?\n\n# Plan\n\n1. Ship it': 'Approve' } }
    })
    await expect(pending).resolves.toEqual({ answers: [{ id: 'review', selected: ['Approve'] }] })
    bridge.dispose()
  })
})
