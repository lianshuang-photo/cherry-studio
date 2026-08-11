import { loggerService } from '@logger'
import { ipcApi } from '@renderer/ipc'
import { KB_MANAGE_TOOL_NAME, kbManageInputSchema } from '@shared/ai/builtinTools'
import type { KnowledgePdfSplitConfirmation } from '@shared/data/types/knowledge'
import { type AbsoluteFilePath, AbsoluteFilePathSchema } from '@shared/types/file'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { PermissionRequestComposerRequest } from './permissionRequestComposerRequest'

const TOKEN_REFRESH_HEADROOM_MS = 30_000
const logger = loggerService.withContext('KnowledgePdfSplitApproval')

type PreparedInput = ReturnType<typeof kbManageInputSchema.parse>
type PreparedPdfAdd = { input: PreparedInput; baseId: string; path: AbsoluteFilePath }

type ApprovalState =
  | { status: 'inactive' }
  | { status: 'loading' }
  | { status: 'ready'; confirmation: KnowledgePdfSplitConfirmation | null }
  | { status: 'error'; message: string }

type ApprovalClaim = {
  updatedInput?: Record<string, unknown>
  restore: () => void
}

function resolvePdfAddInput(toolName: string, rawToolName: string | undefined, input: unknown): PreparedPdfAdd | null {
  const isKnowledgeManage =
    toolName === KB_MANAGE_TOOL_NAME || rawToolName === `mcp__cherry-tools__${KB_MANAGE_TOOL_NAME}`
  if (!isKnowledgeManage) return null

  const parsed = kbManageInputSchema.safeParse(input)
  if (!parsed.success || parsed.data.action !== 'add' || parsed.data.type !== 'file' || !parsed.data.path) return null
  const filePath = AbsoluteFilePathSchema.safeParse(parsed.data.path)
  if (!filePath.success || !filePath.data.toLowerCase().endsWith('.pdf')) return null
  return { input: parsed.data, baseId: parsed.data.baseId, path: filePath.data }
}

async function discardConfirmation(token: string): Promise<void> {
  try {
    await ipcApi.request('knowledge.discard_split_confirmation', { token })
  } catch (error) {
    logger.warn('Failed to discard an AI PDF split confirmation', {
      token,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

export function useKnowledgePdfSplitApproval(request: PermissionRequestComposerRequest) {
  const rawToolName = (request.match.part as unknown as { toolName?: string }).toolName
  const preparedInput = useMemo(
    () => resolvePdfAddInput(request.toolResponse.tool.name, rawToolName, request.match.input),
    [rawToolName, request.match.input, request.toolResponse.tool.name]
  )
  const requestKey = preparedInput ? `${request.approvalId}:${preparedInput.baseId}:${preparedInput.path}` : null
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<ApprovalState>({ status: preparedInput ? 'loading' : 'inactive' })
  const tokenRef = useRef<string | null>(null)

  useEffect(() => {
    if (!preparedInput || !requestKey) {
      setState({ status: 'inactive' })
      return
    }

    let active = true
    setState({ status: 'loading' })
    void ipcApi
      .request('knowledge.preflight_pdf_split_add', { baseId: preparedInput.baseId, path: preparedInput.path })
      .then((confirmation) => {
        if (!active) {
          if (confirmation) void discardConfirmation(confirmation.token)
          return
        }
        tokenRef.current = confirmation?.token ?? null
        setState({ status: 'ready', confirmation })
      })
      .catch((error) => {
        if (!active) return
        setState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
      })

    return () => {
      active = false
      const token = tokenRef.current
      tokenRef.current = null
      if (token) void discardConfirmation(token)
    }
  }, [attempt, preparedInput, requestKey])

  const retry = useCallback(() => {
    const token = tokenRef.current
    tokenRef.current = null
    if (token) void discardConfirmation(token)
    setAttempt((current) => current + 1)
  }, [])

  useEffect(() => {
    if (state.status !== 'ready' || !state.confirmation) return
    const delay = Date.parse(state.confirmation.expiresAt) - Date.now() - TOKEN_REFRESH_HEADROOM_MS
    if (delay <= 0) {
      retry()
      return
    }
    const timeout = window.setTimeout(retry, delay)
    return () => window.clearTimeout(timeout)
  }, [retry, state])

  const discard = useCallback(async () => {
    const token = tokenRef.current
    tokenRef.current = null
    if (token) await discardConfirmation(token)
  }, [])

  const claim = useCallback((): ApprovalClaim => {
    if (!preparedInput || state.status !== 'ready' || !state.confirmation) {
      return { restore: () => undefined }
    }
    const token = state.confirmation.token
    tokenRef.current = null
    return {
      updatedInput: { ...preparedInput.input, splitConfirmationToken: token },
      restore: () => {
        tokenRef.current = token
      }
    }
  }, [preparedInput, state])

  return {
    state,
    isApplicable: preparedInput !== null,
    canApprove: preparedInput === null || state.status === 'ready',
    claim,
    discard,
    retry
  }
}
