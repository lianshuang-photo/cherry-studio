import { randomUUID } from 'node:crypto'

import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionItem,
  AskUserQuestionRequest
} from '@deepseek-ai/dsh-user-questions'
import { type DispatchDecision, toolApprovalRegistry } from '@main/ai/runtime/toolApproval/ToolApprovalRegistry'
import type { AgentRuntimeEvent } from '@main/ai/runtime/types'
import type { AgentPermissionMode } from '@shared/data/api/schemas/agents'
import type { CherryToolMeta } from '@shared/data/types/uiParts'

import { DSH_TRANSPORT } from './dshStreamAdapter'

const READ_ONLY_TOOLS = new Set(['read', 'read_image', 'todo_write', 'skill', 'ask_user_question', 'exit_plan_mode'])
const EDIT_TOOLS = new Set(['write', 'edit'])

type InteractionState = { userResponse: 'stream' | 'message' | 'unavailable' }

export interface DshInteractionBridgeContext {
  sessionId: string
  emit(event: AgentRuntimeEvent): void
  getInteractionState(): InteractionState
  getPermissionMode(): AgentPermissionMode | undefined
  isDisabled(toolName: string): boolean
  approvalRequiredTools: ReadonlySet<string>
}

type PendingQuestionCall = Pick<ToolExecution, 'callId' | 'signal'> & { arguments: Record<string, unknown> }

/**
 * Installs Cherry's approval and human-question seams into a private DSH Context.
 * The caller owns the returned disposer along with the rest of the session tree.
 */
export function installDshInteractionBridge(ctx: Context, options: DshInteractionBridgeContext): () => void {
  const questionCalls = new WeakMap<AbortSignal, PendingQuestionCall>()
  const disposeQuestionProvider = ctx.userQuestions.registerProvider({
    ask: (request) => requestUserQuestion(request, options, questionCalls)
  })
  const disposePreExecute = ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (options.isDisabled(exec.name))
      return { kind: 'deny', reason: `Tool "${exec.name}" is disabled for this agent.` }
    if (exec.name === 'ask_user_question') {
      questionCalls.set(exec.signal, {
        callId: exec.callId,
        signal: exec.signal,
        arguments: asRecord(exec.arguments)
      })
    }
    const decision = await requestToolDecision(exec.name, exec.callId, asRecord(exec.arguments), exec.signal, options)
    return decision ?? next()
  })
  const disposeApprovalRequest = ctx.on(
    'approval/request',
    async (request: ApprovalRequest): Promise<ApprovalOutcome> => {
      if (options.isDisabled(request.toolName)) return 'rejected'
      return requestNativeApproval(request, options)
    }
  )

  return () => {
    disposeApprovalRequest()
    disposePreExecute()
    disposeQuestionProvider()
  }
}

async function requestToolDecision(
  toolName: string,
  toolCallId: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
  options: DshInteractionBridgeContext
): Promise<PreToolDecision | undefined> {
  const mode = normalizePermissionMode(options.getPermissionMode())
  if (mode === 'plan' && !READ_ONLY_TOOLS.has(toolName)) {
    return { kind: 'deny', reason: `Tool "${toolName}" is unavailable while plan mode is active.` }
  }
  if (!requiresApproval(mode, toolName, options.approvalRequiredTools)) return undefined

  const outcome = await waitForDecision({ toolName, toolCallId, input, signal, options })
  return outcome.approved
    ? undefined
    : { kind: 'deny', reason: outcome.reason ?? 'User denied permission for this tool.' }
}

async function requestNativeApproval(
  request: ApprovalRequest,
  options: DshInteractionBridgeContext
): Promise<ApprovalOutcome> {
  const mode = normalizePermissionMode(options.getPermissionMode())
  if (mode === 'plan') return 'rejected'
  if (mode === 'bypassPermissions' && !options.approvalRequiredTools.has(request.toolName)) return 'allowed-once'
  const outcome = await waitForDecision({
    toolName: request.toolName,
    toolCallId: request.callId ?? randomUUID(),
    input: {},
    signal: request.signal,
    options,
    reason: request.reason
  })
  return outcome.approved ? 'allowed-once' : outcome.reason === 'aborted' ? 'cancelled' : 'rejected'
}

function requiresApproval(
  mode: Exclude<AgentPermissionMode, 'auto'>,
  toolName: string,
  approvalRequiredTools: ReadonlySet<string>
): boolean {
  if (approvalRequiredTools.has(toolName)) return true
  if (mode === 'bypassPermissions') return false
  if (READ_ONLY_TOOLS.has(toolName)) return false
  if (mode === 'acceptEdits' && EDIT_TOOLS.has(toolName)) return false
  return true
}

function normalizePermissionMode(mode: AgentPermissionMode | undefined): Exclude<AgentPermissionMode, 'auto'> {
  return mode === 'auto' || mode === undefined ? 'default' : mode
}

type ApprovalWaitOptions = {
  toolName: string
  toolCallId: string
  input: Record<string, unknown>
  signal?: AbortSignal
  reason?: string
  options: DshInteractionBridgeContext
}

function waitForDecision({
  toolName,
  toolCallId,
  input,
  signal,
  reason,
  options
}: ApprovalWaitOptions): Promise<DispatchDecision> {
  const interaction = options.getInteractionState()
  if (interaction.userResponse === 'unavailable') {
    return Promise.resolve({
      approved: false,
      reason: 'This unattended turn cannot request tool approval. Retry interactively.'
    })
  }

  const presentation = interaction.userResponse
  const approvalId = randomUUID()
  return new Promise<DispatchDecision>((resolve) => {
    const pending = toolApprovalRegistry.register({
      approvalId,
      sessionId: options.sessionId,
      toolCallId,
      toolName,
      originalInput: input,
      presentation,
      signal,
      resolve
    })
    if (!pending) return
    options.emit({
      type: 'tool-approval-request',
      request: {
        approvalId,
        toolCallId,
        toolName,
        input,
        presentation,
        providerMetadata: {
          cherry: { transport: DSH_TRANSPORT, toolName, ...(reason ? { reason } : {}) } satisfies CherryToolMeta
        }
      }
    })
  })
}

function requestUserQuestion(
  request: AskUserQuestionRequest,
  options: DshInteractionBridgeContext,
  questionCalls: WeakMap<AbortSignal, PendingQuestionCall>
): Promise<AskUserQuestionAnswer> {
  const call = request.signal ? questionCalls.get(request.signal) : undefined
  const input = toCherryQuestionInput(request.questions)
  const toolCallId = call?.callId ?? randomUUID()
  const signal = request.signal
  return waitForDecision({
    toolName: 'AskUserQuestion',
    toolCallId,
    input,
    signal,
    options
  }).then((decision) => {
    if (signal) questionCalls.delete(signal)
    if (!decision.approved) throw new Error(decision.reason ?? 'User dismissed AskUserQuestion')
    return toDshQuestionAnswer(request.questions, decision.updatedInput)
  })
}

function toCherryQuestionInput(questions: AskUserQuestionItem[]): Record<string, unknown> {
  return {
    questions: questions.map((question) => ({
      question: cherryQuestionText(question),
      header: question.header ?? 'Question',
      options: question.options?.length ? question.options : [{ label: 'Other' }, { label: 'Skip' }],
      multiSelect: question.multiSelect ?? false
    }))
  }
}

function toDshQuestionAnswer(
  questions: AskUserQuestionItem[],
  updatedInput: Record<string, unknown> | undefined
): AskUserQuestionAnswer {
  const answers = asRecord(updatedInput?.answers)
  return {
    answers: questions.map((question) => {
      const value = answers[cherryQuestionText(question)]
      return toDshAnswer(question, typeof value === 'string' ? value : '')
    })
  }
}

function cherryQuestionText(question: AskUserQuestionItem): string {
  return question.detail ? `${question.question}\n\n${question.detail}` : question.question
}

function toDshAnswer(question: AskUserQuestionItem, answer: string) {
  const selected =
    question.options?.filter(
      (option) => answer === option.label || (question.multiSelect && answer.split(', ').includes(option.label))
    ) ?? []
  return selected.length > 0
    ? { id: question.id, selected: selected.map((option) => option.label) }
    : { id: question.id, selected: [], ...(answer ? { custom: answer } : {}) }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
