import { toast } from '@renderer/services/toast'
import type { NormalToolResponse } from '@renderer/types/mcpTool'
import type { CherryMessagePart } from '@shared/data/types/message'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type * as ReactI18next from 'react-i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import PermissionRequestComposer, { type PermissionRequestComposerRequest } from '../PermissionRequestComposer'

const { discardSplitConfirmation, preflightPdfSplitAdd } = vi.hoisted(() => ({
  discardSplitConfirmation: vi.fn(),
  preflightPdfSplitAdd: vi.fn()
}))

vi.mock('@renderer/ipc', () => ({
  ipcApi: {
    request: (route: string, input: unknown) => {
      if (route === 'knowledge.preflight_pdf_split_add') return preflightPdfSplitAdd(input)
      if (route === 'knowledge.discard_split_confirmation') return discardSplitConfirmation(input)
      throw new Error(`Unexpected IPC route: ${route}`)
    }
  }
}))

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactI18next>()),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      ({
        'agent.toolPermission.defaultDenyMessage': 'User denied permission for this tool.',
        'agent.toolPermission.error.sendFailed': 'Failed to send your decision. Please try again.',
        'agent.toolPermission.confirmation': 'Allow tool call?',
        'agent.toolPermission.inputPreview': 'Tool input preview',
        'agent.toolPermission.pending': 'Waiting for confirmation',
        'agent.toolPermission.pdfSplit.preparing': 'Preparing the PDF split plan…',
        'agent.toolPermission.pdfSplit.retry': 'Check again',
        'knowledge.data_source.pdf_split.file_summary': `${options?.pages ?? 0} 页 · ${options?.size ?? ''} · ${options?.parts ?? 0} 个分片`,
        'agent.toolPermission.button.allow': 'Allow',
        'agent.toolPermission.button.deny': 'Deny',
        'agent.toolPermission.button.run': 'Run',
        'agent.toolPermission.waiting': 'Waiting for tool permission decision...',
        'message.processing': 'Processing',
        'message.tools.activity.checking': 'Checking',
        'message.tools.activity.projectChecks': 'project checks',
        'message.tools.activity.relatedContent': 'related content',
        'message.tools.activity.searching': 'Searching',
        'message.tools.activity.usingExtension': 'Bringing in an extension',
        'message.tools.labels.mcpServerTool': 'MCP Server Tool',
        'message.tools.labels.tool': 'Tool',
        'message.tools.sections.input': 'Input'
      })[key] ?? key
  })
}))

vi.mock('@renderer/components/CodeViewer', () => ({
  default: ({ maxHeight, value }: { maxHeight?: number; value: string }) => (
    <div data-max-height={maxHeight} data-testid="code-viewer">
      {value}
    </div>
  )
}))

const part = {
  type: 'tool-CustomTool',
  toolName: 'CustomTool',
  toolCallId: 'call-1',
  state: 'approval-requested',
  input: { command: 'pnpm test' },
  approval: { id: 'approval-1' }
} as unknown as CherryMessagePart

function makeRequest(overrides: Partial<PermissionRequestComposerRequest> = {}): PermissionRequestComposerRequest {
  const toolResponse: NormalToolResponse = {
    id: 'call-1',
    toolCallId: 'call-1',
    status: 'pending',
    arguments: { command: 'pnpm test' },
    tool: {
      id: 'call-1',
      name: 'CustomTool',
      type: 'builtin'
    }
  }

  return {
    messageId: 'message-1',
    toolCallId: 'call-1',
    approvalId: 'approval-1',
    title: 'CustomTool',
    toolResponse,
    match: {
      part,
      state: 'approval-requested',
      toolCallId: 'call-1',
      messageId: 'message-1',
      approvalId: 'approval-1',
      input: { command: 'pnpm test' }
    },
    ...overrides
  }
}

function makePdfRequest(rawToolName = 'kb_manage'): PermissionRequestComposerRequest {
  const input = { baseId: 'kb-1', action: 'add' as const, type: 'file' as const, path: '/docs/report.pdf' }
  const pdfPart = { ...part, type: 'tool-kb_manage', toolName: rawToolName, input }
  return makeRequest({
    title: 'kb_manage',
    toolResponse: {
      id: 'call-1',
      toolCallId: 'call-1',
      status: 'pending',
      arguments: input,
      tool: { id: 'call-1', name: 'kb_manage', type: 'builtin' }
    },
    match: {
      part: pdfPart as unknown as CherryMessagePart,
      state: 'approval-requested',
      toolCallId: 'call-1',
      messageId: 'message-1',
      approvalId: 'approval-1',
      input
    }
  })
}

const splitConfirmation = {
  token: 'split-token',
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  processorId: 'local-document',
  files: [
    {
      sourceName: 'report.pdf',
      pageCount: 31,
      sourceBytes: 1024 * 1024,
      parts: [
        { pageStart: 1, pageEnd: 30, bytes: 700_000 },
        { pageStart: 31, pageEnd: 31, bytes: 100_000 }
      ]
    }
  ],
  totalTasks: 2,
  estimatedDiskBytes: 4 * 1024 * 1024
}

describe('PermissionRequestComposer', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  beforeEach(() => {
    discardSplitConfirmation.mockReset()
    discardSplitConfirmation.mockResolvedValue(undefined)
    preflightPdfSplitAdd.mockReset()
  })

  it('marks the root panel as a composer viewport inset target', () => {
    const { container } = render(<PermissionRequestComposer request={makeRequest()} onRespond={vi.fn()} />)

    expect(container.firstElementChild).toHaveAttribute('data-composer-viewport-inset-target', '')
  })

  it('submits an approval decision', async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined)
    render(
      <PermissionRequestComposer
        request={makeRequest({ title: 'Allow CustomTool to run focused tests?' })}
        onRespond={onRespond}
      />
    )

    expect(screen.getByRole('heading', { name: 'Processing' })).toBeInTheDocument()
    expect(screen.getByText('Allow CustomTool to run focused tests?')).toBeInTheDocument()
    expect(screen.queryByText('Tool input preview')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))

    await waitFor(() => expect(onRespond).toHaveBeenCalledTimes(1))
    expect(onRespond).toHaveBeenCalledWith({
      match: makeRequest().match,
      approved: true
    })
  })

  it('submits a denial decision with the default deny reason', async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined)
    render(<PermissionRequestComposer request={makeRequest()} onRespond={onRespond} />)

    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))

    await waitFor(() => expect(onRespond).toHaveBeenCalledTimes(1))
    expect(onRespond).toHaveBeenCalledWith({
      match: makeRequest().match,
      approved: false,
      reason: 'User denied permission for this tool.'
    })
  })

  it.each(['kb_manage', 'mcp__cherry-tools__kb_manage'])(
    'prepares an exact PDF plan for %s and approves with its token',
    async (rawToolName) => {
      preflightPdfSplitAdd.mockResolvedValue(splitConfirmation)
      const onRespond = vi.fn().mockResolvedValue(undefined)
      render(<PermissionRequestComposer request={makePdfRequest(rawToolName)} onRespond={onRespond} />)

      expect(screen.getByRole('button', { name: 'Allow' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Deny' })).toBeEnabled()
      expect(await screen.findByText('31 页 · 1.0 MB · 2 个分片')).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Allow' }))

      await waitFor(() =>
        expect(onRespond).toHaveBeenCalledWith({
          match: makePdfRequest(rawToolName).match,
          approved: true,
          updatedInput: {
            baseId: 'kb-1',
            action: 'add',
            type: 'file',
            path: '/docs/report.pdf',
            splitConfirmationToken: 'split-token'
          }
        })
      )
      expect(discardSplitConfirmation).not.toHaveBeenCalled()
    }
  )

  it('discards a prepared PDF split before denying the tool', async () => {
    preflightPdfSplitAdd.mockResolvedValue(splitConfirmation)
    const onRespond = vi.fn().mockResolvedValue(undefined)
    render(<PermissionRequestComposer request={makePdfRequest()} onRespond={onRespond} />)

    await screen.findByText('31 页 · 1.0 MB · 2 个分片')
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))

    await waitFor(() => expect(discardSplitConfirmation).toHaveBeenCalledWith({ token: 'split-token' }))
    expect(onRespond).toHaveBeenCalledWith({
      match: makePdfRequest().match,
      approved: false,
      reason: 'User denied permission for this tool.'
    })
  })

  it('keeps approval disabled after a PDF preflight error and allows retry', async () => {
    preflightPdfSplitAdd.mockRejectedValueOnce(new Error('PDF is encrypted')).mockResolvedValueOnce(null)
    render(<PermissionRequestComposer request={makePdfRequest()} onRespond={vi.fn()} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('PDF is encrypted')
    expect(screen.getByRole('button', { name: 'Allow' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled())
  })

  it('discards a split plan that finishes after its approval card leaves', async () => {
    let resolvePreflight!: (value: typeof splitConfirmation) => void
    preflightPdfSplitAdd.mockReturnValue(
      new Promise((resolve) => {
        resolvePreflight = resolve
      })
    )
    const { unmount } = render(<PermissionRequestComposer request={makePdfRequest()} onRespond={vi.fn()} />)

    unmount()
    resolvePreflight(splitConfirmation)

    await waitFor(() => expect(discardSplitConfirmation).toHaveBeenCalledWith({ token: 'split-token' }))
  })

  it('refreshes a prepared plan before its token reaches the expiry window', async () => {
    vi.useFakeTimers()
    const first = { ...splitConfirmation, expiresAt: new Date(Date.now() + 31_000).toISOString() }
    const second = { ...splitConfirmation, token: 'split-token-2' }
    preflightPdfSplitAdd.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    render(<PermissionRequestComposer request={makePdfRequest()} onRespond={vi.fn()} />)

    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled()

    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
    })

    expect(discardSplitConfirmation).toHaveBeenCalledWith({ token: 'split-token' })
    expect(preflightPdfSplitAdd).toHaveBeenCalledTimes(2)
  })

  it('renders MCP tool name with the argument preview', () => {
    render(
      <PermissionRequestComposer
        request={makeRequest({
          title: 'lookup_docs',
          toolResponse: {
            id: 'mcp-call-1',
            toolCallId: 'mcp-call-1',
            status: 'pending',
            arguments: { query: 'composer' },
            tool: {
              id: 'docs-server__lookup_docs',
              name: 'lookup_docs',
              description: 'Search project documentation.',
              type: 'mcp',
              serverId: 'docs-server',
              serverName: 'Docs',
              inputSchema: { type: 'object', properties: {}, required: [] }
            }
          }
        })}
        onRespond={vi.fn()}
      />
    )

    expect(screen.getByRole('heading', { name: 'Bringing in an extension' })).toBeInTheDocument()
    expect(screen.getByText('Search project documentation.')).toBeInTheDocument()
    expect(screen.getByTestId('permission-preview')).not.toHaveClass('overflow-y-auto')
    expect(screen.getByTestId('permission-mcp-args-scroll')).toHaveClass('max-h-60', 'overflow-y-auto')
    expect(screen.queryByText('Docs : lookup_docs')).not.toBeInTheDocument()
    expect(screen.getByText('query')).toBeInTheDocument()
    expect(screen.getByText('composer')).toBeInTheDocument()
  })

  it('bounds builtin previews that do not own their own scroll region', () => {
    render(<PermissionRequestComposer request={makeRequest()} onRespond={vi.fn()} />)

    expect(screen.getByTestId('permission-preview')).not.toHaveClass('overflow-y-auto')
    expect(screen.getByTestId('permission-builtin-body-scroll')).toHaveClass('max-h-60', 'overflow-y-auto')
  })

  it('does not add a fallback body scroller when the tool content owns scrolling', () => {
    render(
      <PermissionRequestComposer
        request={makeRequest({
          title: 'Write',
          toolResponse: {
            id: 'write-call-1',
            toolCallId: 'write-call-1',
            status: 'pending',
            arguments: {
              file_path: '/tmp/cherry-approval-long-preview-note.md',
              content: '# Long approval preview\n\nA long document body.'
            },
            tool: {
              id: 'Write',
              name: 'Write',
              type: 'builtin'
            }
          }
        })}
        onRespond={vi.fn()}
      />
    )

    expect(screen.getByTestId('code-viewer')).toHaveAttribute('data-max-height', '240')
    expect(screen.queryByTestId('permission-builtin-body-scroll')).not.toBeInTheDocument()
  })

  it('uses the streaming tool icon and semantic title for the approval header', () => {
    render(
      <PermissionRequestComposer
        request={makeRequest({
          title: 'Bash',
          toolResponse: {
            id: 'bash-call-1',
            toolCallId: 'bash-call-1',
            status: 'pending',
            arguments: { command: 'pnpm test' },
            tool: {
              id: 'Bash',
              name: 'Bash',
              type: 'builtin'
            }
          }
        })}
        onRespond={vi.fn()}
      />
    )

    const heading = screen.getByRole('heading', { name: 'Checking project checks' })
    expect(heading.querySelector('.lucide-square-terminal')).toBeInTheDocument()
    expect(screen.queryByText('Allow tool call?')).not.toBeInTheDocument()
  })

  it('hides the request subtitle when it only repeats the tool name', () => {
    render(<PermissionRequestComposer request={makeRequest()} onRespond={vi.fn()} />)

    const heading = screen.getByRole('heading', { name: 'Processing' })
    expect(heading.parentElement?.children).toHaveLength(1)
  })

  it('disables actions while a response is submitting', async () => {
    const onRespond = vi.fn(() => new Promise<void>(() => undefined))
    render(<PermissionRequestComposer request={makeRequest()} onRespond={onRespond} />)

    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))

    await waitFor(() => expect(onRespond).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: 'Allow' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled()
  })

  it('re-enables the request when submitting the response fails', async () => {
    const onRespond = vi.fn().mockRejectedValue(new Error('failed'))
    render(<PermissionRequestComposer request={makeRequest()} onRespond={onRespond} />)

    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))

    await waitFor(() => expect(onRespond).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to send your decision. Please try again.'))
    expect(screen.getByRole('button', { name: 'Allow' })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: 'Deny' })).not.toBeDisabled()
  })
})
