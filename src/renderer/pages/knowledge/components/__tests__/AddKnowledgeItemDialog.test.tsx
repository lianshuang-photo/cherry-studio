import { toast } from '@renderer/services/toast'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import AddKnowledgeItemDialog from '../AddKnowledgeItemDialog'

const mockSubmitKnowledgeItems = vi.fn()
const mockDiscardKnowledgePdfSplitConfirmation = vi.fn()
const mockUseKnowledgePage = vi.fn()
const mockUseAddKnowledgeItems = vi.fn()
const mockFileSelect = vi.fn()
const mockSelectFolder = vi.fn()
const mockGetPathForFile = vi.fn()
const mockReadExternal = vi.fn()
const mockUseDirectoryTree = vi.fn()
const mockProjectNotesTree = vi.fn()

const createNoteNode = (name: string, externalPath: string) => ({
  id: externalPath,
  name,
  type: 'file' as const,
  treePath: `/${name}`,
  externalPath,
  createdAt: '',
  updatedAt: ''
})

// Native picker returns FileMetadata; only `path` + `origin_name`/`name` are read downstream.
const createSelectedFile = (name: string, path = `/picked/${name}`) => ({ name, origin_name: name, path }) as never

const createMockFile = (name: string, size: number) =>
  new File([new Uint8Array(size)], name, { type: 'application/octet-stream' })

const createDeferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

vi.mock('../../KnowledgePageProvider', () => ({
  useKnowledgePage: () => mockUseKnowledgePage()
}))

vi.mock('@renderer/hooks/useKnowledgeItems', () => ({
  discardKnowledgePdfSplitConfirmation: (...args: unknown[]) => mockDiscardKnowledgePdfSplitConfirmation(...args),
  useAddKnowledgeItems: (...args: unknown[]) => mockUseAddKnowledgeItems(...args)
}))

// The note picker's real data layer (useNotesSettings → NotesService → @renderer/utils)
// pulls in the i18n bootstrap at module load, which throws under the react-i18next mock.
// Stub the three note modules so the dialog graph stays bootstrap-free and the note list
// is fully controllable from each test.
vi.mock('@renderer/hooks/useNotesSettings', () => ({
  useNotesSettings: () => ({ notesPath: '/notes' })
}))

vi.mock('@renderer/hooks/useDirectoryTree', () => ({
  useDirectoryTree: () => mockUseDirectoryTree()
}))

vi.mock('@renderer/services/NotesService', () => ({
  projectNotesTree: () => mockProjectNotesTree()
}))

// The real RichEditor boots Tiptap (and its extension graph) on mount, which is far more
// than this dialog's contract needs. Stand in a textarea that speaks the same
// `initialContent` / `onMarkdownChange` protocol.
vi.mock('@renderer/components/RichEditor/RichEditor', () => ({
  default: ({
    initialContent,
    placeholder,
    onMarkdownChange,
    enableImageInsertion
  }: {
    initialContent?: string
    placeholder?: string
    onMarkdownChange?: (markdown: string) => void
    enableImageInsertion?: boolean
  }) => (
    <textarea
      defaultValue={initialContent}
      placeholder={placeholder}
      data-images-enabled={enableImageInsertion ?? true}
      onChange={(event) => onMarkdownChange?.(event.target.value)}
    />
  )
}))

vi.mock('@cherrystudio/ui', async () => {
  const React = await import('react')

  const DialogContext = React.createContext<{ onOpenChange: (open: boolean) => void; open: boolean }>({
    onOpenChange: () => undefined,
    open: false
  })

  return {
    Button: ({
      children,
      loading,
      type = 'button',
      ...props
    }: {
      children: React.ReactNode
      loading?: boolean
      type?: 'button' | 'submit' | 'reset'
      [key: string]: unknown
    }) => (
      <button type={type} aria-busy={loading || undefined} {...props}>
        {children}
      </button>
    ),
    Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
    Label: ({ children, ...props }: { children: React.ReactNode; [key: string]: unknown }) => (
      <label {...props}>{children}</label>
    ),
    SegmentedControl: ({
      options,
      value,
      onValueChange
    }: {
      options: { value: string; label: React.ReactNode }[]
      value?: string
      onValueChange?: (value: string) => void
    }) => (
      <div role="radiogroup">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={option.value === value}
            onClick={() => onValueChange?.(option.value)}>
            {option.label}
          </button>
        ))}
      </div>
    ),
    Checkbox: ({
      checked,
      onCheckedChange,
      ...props
    }: {
      checked?: boolean
      onCheckedChange?: (checked: boolean) => void
      [key: string]: unknown
    }) => (
      <input
        type="checkbox"
        checked={Boolean(checked)}
        onChange={(event) => onCheckedChange?.(event.target.checked)}
        {...props}
      />
    ),
    Dialog: ({
      children,
      open,
      onOpenChange
    }: {
      children: React.ReactNode
      open: boolean
      onOpenChange: (open: boolean) => void
    }) => <DialogContext value={{ open, onOpenChange }}>{children}</DialogContext>,
    DialogClose: ({
      asChild,
      children,
      ...props
    }: {
      asChild?: boolean
      children: React.ReactElement<{ onClick?: (event: React.MouseEvent<HTMLElement>) => void }>
      [key: string]: unknown
    }) => {
      const { onOpenChange } = React.use(DialogContext)

      if (asChild) {
        return (
          <span role="presentation" {...props} onClick={() => onOpenChange(false)}>
            {children}
          </span>
        )
      }

      return (
        <button type="button" {...props}>
          {children}
        </button>
      )
    },
    DialogContent: ({
      children,
      size,
      ...props
    }: {
      children: React.ReactNode
      showCloseButton?: boolean
      size?: string
      [key: string]: unknown
    }) => {
      const { open } = React.use(DialogContext)
      const dialogProps = { ...props }
      delete dialogProps.closeOnOverlayClick
      delete dialogProps.showCloseButton

      return open ? (
        <div role="dialog" data-size={size} {...dialogProps}>
          {children}
        </div>
      ) : null
    },
    DialogFooter: ({ children, ...props }: { children: React.ReactNode; [key: string]: unknown }) => (
      <div {...props}>{children}</div>
    ),
    DialogHeader: ({ children, ...props }: { children: React.ReactNode; [key: string]: unknown }) => (
      <div {...props}>{children}</div>
    ),
    DialogTitle: ({ children, ...props }: { children: React.ReactNode; [key: string]: unknown }) => (
      <h1 {...props}>{children}</h1>
    ),
    DialogDescription: ({ children, ...props }: { children: React.ReactNode; [key: string]: unknown }) => (
      <p {...props}>{children}</p>
    )
  }
})

vi.mock('react-i18next', () => {
  // A single stable `t` reference (like the real react-i18next), so effects that depend
  // on `t` are not re-triggered every render.
  const t = (
    key: string,
    options?: {
      count?: number
      defaultValue?: string
      file_types?: string
      pages?: number
      parts?: number
      size?: string
    }
  ) => {
    const translations = {
      'common.add': '添加',
      'common.cancel': '取消',
      'common.close': '关闭',
      'common.delete': '删除',
      'common.select_all': '全选',
      'knowledge.data_source.add_dialog.conflict_dialog.title': '存在同名数据源',
      'knowledge.data_source.add_dialog.conflict_dialog.description': `有 ${options?.count ?? 0} 个数据源与知识库中已存在的项目同名，请选择处理方式。`,
      'knowledge.data_source.add_dialog.conflict_dialog.keep_all': '全部保留',
      'knowledge.data_source.add_dialog.conflict_dialog.replace': '替换',
      'knowledge.data_source.add_dialog.footer.selected_notes': `已选 ${options?.count ?? 0} 个笔记`,
      'knowledge.data_source.add_dialog.note.description': '选择已有笔记作为知识库数据源',
      'knowledge.data_source.add_dialog.note.empty_description': '请先在「笔记」功能中创建笔记，再回到这里选择。',
      'knowledge.data_source.add_dialog.note.empty_title': '未找到笔记',
      'knowledge.data_source.add_dialog.note.loading': '正在加载笔记…',
      'knowledge.data_source.add_dialog.note.mode.import': '导入笔记',
      'knowledge.data_source.add_dialog.note.mode.create': '新建笔记',
      'knowledge.data_source.add_dialog.note.create.title_label': '标题',
      'knowledge.data_source.add_dialog.note.create.title_placeholder': '为这篇笔记取个名字',
      'knowledge.data_source.add_dialog.note.create.content_placeholder': '在此输入笔记内容…',
      'notes.tree_load_failed': '加载笔记目录失败',
      'knowledge.data_source.add_dialog.sources.directory': '目录',
      'knowledge.data_source.add_dialog.sources.file': '文件',
      'knowledge.data_source.add_dialog.sources.note': '笔记',
      'knowledge.data_source.add_dialog.sources.url': '链接',
      'knowledge.data_source.add_dialog.submit.error': '添加数据源失败',
      'knowledge.data_source.add_dialog.title': '添加数据源',
      'knowledge.data_source.add_dialog.too_many_sources': `单次最多添加 ${options?.count ?? 0} 个数据源，请减少选择后重试`,
      'knowledge.data_source.add_dialog.unsupported_files_skipped': `已跳过 ${options?.count ?? 0} 个不支持的文件`,
      'knowledge.data_source.add_dialog.url.description': '输入网页链接：',
      'knowledge.data_source.add_dialog.url.help': '将自动抓取页面文本并分块索引',
      'knowledge.data_source.add_dialog.url.placeholder': 'https://example.com',
      'knowledge.data_source.pdf_split.confirm': '拆分并上传',
      'knowledge.data_source.pdf_split.description': '这些 PDF 超出 Doc2X 的稳定处理范围。',
      'knowledge.data_source.pdf_split.file_summary': `${options?.pages ?? 0} 页 · ${options?.size ?? ''} · ${options?.parts ?? 0} 个分片`,
      'knowledge.data_source.pdf_split.preparing_description': '正在检查页数并生成本地分片，请稍候。',
      'knowledge.data_source.pdf_split.preparing_title': '正在准备 PDF 拆分方案',
      'knowledge.data_source.pdf_split.title': '拆分大型 PDF 文件',
      'provider.doc2x': 'Doc2X'
    } satisfies Record<string, string>

    return translations[key] ?? options?.defaultValue ?? key
  }

  return { useTranslation: () => ({ t }) }
})

describe('AddKnowledgeItemDialog', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mockUseKnowledgePage.mockReturnValue({ selectedBaseId: 'base-1', pendingAddSource: 'file' })
    mockUseAddKnowledgeItems.mockReturnValue({
      submit: mockSubmitKnowledgeItems,
      isSubmitting: false,
      error: undefined
    })
    mockSubmitKnowledgeItems.mockResolvedValue({ status: 'added' })
    mockDiscardKnowledgePdfSplitConfirmation.mockResolvedValue(undefined)
    // Default: picker cancelled, so a render that does not arrange a selection just closes.
    mockFileSelect.mockResolvedValue(null)
    mockSelectFolder.mockResolvedValue(null)
    mockGetPathForFile.mockImplementation((file: File) => `/external/${file.name}`)
    mockUseDirectoryTree.mockReturnValue({ root: {}, isLoading: false, error: null })
    mockProjectNotesTree.mockReturnValue([])
    ;(window as any).api = {
      file: {
        select: mockFileSelect,
        selectFolder: mockSelectFolder,
        getPathForFile: mockGetPathForFile,
        readExternal: mockReadExternal
      }
    }
  })

  const setPendingAddSource = (pendingAddSource: 'file' | 'note' | 'directory' | 'url') => {
    mockUseKnowledgePage.mockReturnValue({ selectedBaseId: 'base-1', pendingAddSource })
  }

  const setPendingAddFiles = (pendingAddFiles: File[]) => {
    mockUseKnowledgePage.mockReturnValue({ selectedBaseId: 'base-1', pendingAddSource: 'file', pendingAddFiles })
  }

  describe('file source (native picker, no panel)', () => {
    it('opens the OS file picker on mount instead of rendering a panel', async () => {
      mockFileSelect.mockResolvedValueOnce([createSelectedFile('alpha.pdf')])
      const onOpenChange = vi.fn()
      render(<AddKnowledgeItemDialog open onOpenChange={onOpenChange} />)

      await waitFor(() => {
        expect(mockFileSelect).toHaveBeenCalledWith(
          expect.objectContaining({ properties: ['openFile', 'multiSelections'] })
        )
      })
      // No "添加数据源" panel for the file source.
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(screen.queryByRole('heading', { name: '添加数据源' })).not.toBeInTheDocument()
    })

    it('submits picked files via detect and closes when added', async () => {
      mockFileSelect.mockResolvedValueOnce([createSelectedFile('alpha.pdf', '/docs/alpha.pdf')])
      const onOpenChange = vi.fn()
      render(<AddKnowledgeItemDialog open onOpenChange={onOpenChange} />)

      await waitFor(() => {
        expect(mockSubmitKnowledgeItems).toHaveBeenCalledWith(
          [{ type: 'file', data: { source: '/docs/alpha.pdf', path: '/docs/alpha.pdf' } }],
          'detect'
        )
      })
      await waitFor(() => {
        expect(onOpenChange).toHaveBeenCalledWith(false)
      })
      expect(toast.error).not.toHaveBeenCalled()
    })

    it('closes without submitting when the picker is cancelled', async () => {
      mockFileSelect.mockResolvedValueOnce(null)
      const onOpenChange = vi.fn()
      render(<AddKnowledgeItemDialog open onOpenChange={onOpenChange} />)

      await waitFor(() => {
        expect(onOpenChange).toHaveBeenCalledWith(false)
      })
      expect(mockSubmitKnowledgeItems).not.toHaveBeenCalled()
    })

    it('drops unsupported picks and warns about the skipped count', async () => {
      mockFileSelect.mockResolvedValueOnce([createSelectedFile('alpha.pdf'), createSelectedFile('photo.png')])
      render(<AddKnowledgeItemDialog open onOpenChange={vi.fn()} />)

      await waitFor(() => {
        expect(mockSubmitKnowledgeItems).toHaveBeenCalledWith(
          [{ type: 'file', data: { source: '/picked/alpha.pdf', path: '/picked/alpha.pdf' } }],
          'detect'
        )
      })
      expect(toast.warning).toHaveBeenCalledWith('已跳过 1 个不支持的文件')
    })

    it('submits page-level pending files without opening the picker', async () => {
      setPendingAddFiles([createMockFile('external.pdf', 1024), createMockFile('external.exe', 1024)])
      render(<AddKnowledgeItemDialog open onOpenChange={vi.fn()} />)

      await waitFor(() => {
        expect(mockSubmitKnowledgeItems).toHaveBeenCalledWith(
          [{ type: 'file', data: { source: '/external/external.pdf', path: '/external/external.pdf' } }],
          'detect'
        )
      })
      expect(mockFileSelect).not.toHaveBeenCalled()
      expect(toast.warning).toHaveBeenCalledWith('已跳过 1 个不支持的文件')
    })

    it('warns and skips submit when the pick exceeds the per-batch limit', async () => {
      const tooMany = Array.from({ length: 21 }, (_, index) => createSelectedFile(`doc-${index}.pdf`))
      mockFileSelect.mockResolvedValueOnce(tooMany)
      const onOpenChange = vi.fn()
      render(<AddKnowledgeItemDialog open onOpenChange={onOpenChange} />)

      await waitFor(() => {
        expect(toast.warning).toHaveBeenCalledWith('单次最多添加 20 个数据源，请减少选择后重试')
      })
      expect(mockSubmitKnowledgeItems).not.toHaveBeenCalled()
      await waitFor(() => {
        expect(onOpenChange).toHaveBeenCalledWith(false)
      })
    })

    it('submits a batch sitting exactly at the per-batch limit', async () => {
      const atLimit = Array.from({ length: 20 }, (_, index) => createSelectedFile(`doc-${index}.pdf`))
      mockFileSelect.mockResolvedValueOnce(atLimit)
      render(<AddKnowledgeItemDialog open onOpenChange={vi.fn()} />)

      await waitFor(() => {
        expect(mockSubmitKnowledgeItems).toHaveBeenCalledTimes(1)
      })
      expect(mockSubmitKnowledgeItems.mock.calls[0][0]).toHaveLength(20)
      expect(toast.warning).not.toHaveBeenCalled()
    })

    it('toasts and closes when the submit rejects (no panel to fall back to)', async () => {
      mockFileSelect.mockResolvedValueOnce([createSelectedFile('alpha.pdf')])
      mockSubmitKnowledgeItems.mockRejectedValueOnce(new Error('create failed'))
      const onOpenChange = vi.fn()
      render(<AddKnowledgeItemDialog open onOpenChange={onOpenChange} />)

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('添加数据源失败: create failed')
      })
      await waitFor(() => {
        expect(onOpenChange).toHaveBeenCalledWith(false)
      })
    })

    it('shows the split plan and confirms the same upload with its token', async () => {
      const confirmation = createPdfSplitConfirmation()
      mockFileSelect.mockResolvedValueOnce([createSelectedFile('alpha.pdf', '/docs/alpha.pdf')])
      mockSubmitKnowledgeItems
        .mockResolvedValueOnce({ status: 'split_confirmation_required', confirmation })
        .mockResolvedValueOnce({ status: 'added' })
      const onOpenChange = vi.fn()
      render(<AddKnowledgeItemDialog open onOpenChange={onOpenChange} />)

      expect(await screen.findByRole('heading', { name: '拆分大型 PDF 文件' })).toBeInTheDocument()
      expect(screen.getByText('alpha.pdf')).toBeInTheDocument()
      expect(screen.getByText('31 页 · 1.0 MB · 2 个分片')).toBeInTheDocument()
      expect(onOpenChange).not.toHaveBeenCalledWith(false)

      fireEvent.click(screen.getByRole('button', { name: '拆分并上传' }))

      await waitFor(() => {
        expect(mockSubmitKnowledgeItems).toHaveBeenNthCalledWith(
          2,
          [{ type: 'file', data: { source: '/docs/alpha.pdf', path: '/docs/alpha.pdf' } }],
          'detect',
          confirmation.token
        )
      })
      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    })

    it('shows delayed PDF preparation feedback and replaces it with the exact split plan', async () => {
      vi.useFakeTimers()
      const confirmation = createPdfSplitConfirmation()
      const submission = createDeferred<{ status: 'split_confirmation_required'; confirmation: typeof confirmation }>()
      mockFileSelect.mockResolvedValueOnce([createSelectedFile('alpha.pdf', '/docs/alpha.pdf')])
      mockSubmitKnowledgeItems.mockReturnValueOnce(submission.promise)
      render(<AddKnowledgeItemDialog open onOpenChange={vi.fn()} />)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(249)
      })
      expect(screen.queryByRole('heading', { name: '正在准备 PDF 拆分方案' })).not.toBeInTheDocument()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1)
      })
      expect(screen.getByRole('heading', { name: '正在准备 PDF 拆分方案' })).toBeInTheDocument()
      expect(screen.getByText('alpha.pdf')).toBeInTheDocument()
      expect(screen.getByText('正在检查页数并生成本地分片，请稍候。')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: '拆分并上传' })).not.toBeInTheDocument()

      await act(async () => {
        submission.resolve({ status: 'split_confirmation_required', confirmation })
        await Promise.resolve()
      })

      expect(screen.getByRole('heading', { name: '拆分大型 PDF 文件' })).toBeInTheDocument()
      expect(screen.getByText('31 页 · 1.0 MB · 2 个分片')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '拆分并上传' })).toBeEnabled()
    })

    it.each([
      { name: 'quick PDF', file: createSelectedFile('alpha.pdf'), resolvesImmediately: true },
      { name: 'slow non-PDF', file: createSelectedFile('notes.txt'), resolvesImmediately: false }
    ])('does not show PDF preparation feedback for a $name submission', async ({ file, resolvesImmediately }) => {
      vi.useFakeTimers()
      const submission = createDeferred<{ status: 'added' }>()
      mockFileSelect.mockResolvedValueOnce([file])
      mockSubmitKnowledgeItems.mockReturnValueOnce(submission.promise)
      render(<AddKnowledgeItemDialog open onOpenChange={vi.fn()} />)

      if (resolvesImmediately) {
        await act(async () => {
          submission.resolve({ status: 'added' })
          await Promise.resolve()
        })
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250)
      })

      expect(screen.queryByRole('heading', { name: '正在准备 PDF 拆分方案' })).not.toBeInTheDocument()
      await act(async () => {
        submission.resolve({ status: 'added' })
        await Promise.resolve()
      })
    })

    it('discards the split token and adds nothing when confirmation is cancelled', async () => {
      const confirmation = createPdfSplitConfirmation()
      mockFileSelect.mockResolvedValueOnce([createSelectedFile('alpha.pdf')])
      mockSubmitKnowledgeItems.mockResolvedValueOnce({ status: 'split_confirmation_required', confirmation })
      const onOpenChange = vi.fn()
      render(<AddKnowledgeItemDialog open onOpenChange={onOpenChange} />)

      fireEvent.click(await screen.findByRole('button', { name: '取消' }))

      expect(mockSubmitKnowledgeItems).toHaveBeenCalledTimes(1)
      expect(mockDiscardKnowledgePdfSplitConfirmation).toHaveBeenCalledWith(confirmation.token)
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
  })

  describe('directory source (native picker, no panel)', () => {
    it('opens the OS folder picker and submits the chosen folder via detect', async () => {
      setPendingAddSource('directory')
      mockSelectFolder.mockResolvedValueOnce('/Users/me/docs')
      const onOpenChange = vi.fn()
      render(<AddKnowledgeItemDialog open onOpenChange={onOpenChange} />)

      await waitFor(() => {
        expect(mockSubmitKnowledgeItems).toHaveBeenCalledWith(
          [{ type: 'directory', data: { source: '/Users/me/docs' } }],
          'detect'
        )
      })
      await waitFor(() => {
        expect(onOpenChange).toHaveBeenCalledWith(false)
      })
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('closes without submitting when the folder picker is cancelled', async () => {
      setPendingAddSource('directory')
      mockSelectFolder.mockResolvedValueOnce(null)
      const onOpenChange = vi.fn()
      render(<AddKnowledgeItemDialog open onOpenChange={onOpenChange} />)

      await waitFor(() => {
        expect(onOpenChange).toHaveBeenCalledWith(false)
      })
      expect(mockSubmitKnowledgeItems).not.toHaveBeenCalled()
    })
  })

  describe('note source (panel)', () => {
    it('renders the note picker and reflects selection in the footer', () => {
      setPendingAddSource('note')
      mockProjectNotesTree.mockReturnValue([
        createNoteNode('Meeting notes', '/notes/Meeting notes.md'),
        createNoteNode('Ideas', '/notes/Ideas.md')
      ])
      render(<AddKnowledgeItemDialog open onOpenChange={vi.fn()} />)

      expect(screen.getByRole('dialog')).toHaveAttribute('data-size', 'lg')
      expect(screen.getByText('Meeting notes')).toBeInTheDocument()
      expect(screen.getByText('Ideas')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '添加' })).toBeDisabled()

      fireEvent.click(screen.getByRole('checkbox', { name: /Meeting notes/ }))

      expect(screen.getByText('已选 1 个笔记')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '添加' })).toBeEnabled()
    })

    it('selects and deselects every note from the list header', () => {
      setPendingAddSource('note')
      mockProjectNotesTree.mockReturnValue([
        createNoteNode('Meeting notes', '/notes/Meeting notes.md'),
        createNoteNode('Ideas', '/notes/Ideas.md')
      ])
      render(<AddKnowledgeItemDialog open onOpenChange={vi.fn()} />)

      const selectAll = screen.getByRole('checkbox', { name: '全选' })
      fireEvent.click(selectAll)

      expect(screen.getByText('已选 2 个笔记')).toBeInTheDocument()
      expect(screen.getByRole('checkbox', { name: /Meeting notes/ })).toBeChecked()
      expect(screen.getByRole('checkbox', { name: /Ideas/ })).toBeChecked()

      fireEvent.click(selectAll)

      expect(screen.queryByText('已选 2 个笔记')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: '添加' })).toBeDisabled()
      expect(screen.getByRole('checkbox', { name: /Meeting notes/ })).not.toBeChecked()
      expect(screen.getByRole('checkbox', { name: /Ideas/ })).not.toBeChecked()
    })

    it('submits note source body through the generic hook', async () => {
      setPendingAddSource('note')
      mockProjectNotesTree.mockReturnValue([createNoteNode('Meeting notes', '/notes/Meeting notes.md')])
      mockReadExternal.mockResolvedValueOnce('# Meeting\n\nbody')
      render(<AddKnowledgeItemDialog open onOpenChange={vi.fn()} />)

      fireEvent.click(screen.getByRole('checkbox', { name: /Meeting notes/ }))
      fireEvent.click(screen.getByRole('button', { name: '添加' }))

      await waitFor(() => {
        expect(mockSubmitKnowledgeItems).toHaveBeenLastCalledWith(
          [{ type: 'note', data: { source: 'Meeting notes', content: '# Meeting\n\nbody' } }],
          'detect'
        )
      })
      expect(mockReadExternal).toHaveBeenCalledWith('/notes/Meeting notes.md')
    })

    it('shows an inline error and skips submit when more notes than the limit are selected', async () => {
      setPendingAddSource('note')
      mockReadExternal.mockResolvedValue('body')
      const notes = Array.from({ length: 21 }, (_, index) => createNoteNode(`Note ${index}`, `/notes/Note ${index}.md`))
      mockProjectNotesTree.mockReturnValue(notes)
      render(<AddKnowledgeItemDialog open onOpenChange={vi.fn()} />)

      fireEvent.click(screen.getByRole('checkbox', { name: '全选' }))
      fireEvent.click(screen.getByRole('button', { name: '添加' }))

      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent('单次最多添加 20 个数据源，请减少选择后重试')
      expect(mockSubmitKnowledgeItems).not.toHaveBeenCalled()
    })

    it('surfaces a note tree load error instead of the empty state', () => {
      setPendingAddSource('note')
      mockUseDirectoryTree.mockReturnValue({ root: null, isLoading: false, error: new Error('read failed') })
      render(<AddKnowledgeItemDialog open onOpenChange={vi.fn()} />)

      expect(screen.getByText('加载笔记目录失败')).toBeInTheDocument()
      expect(screen.queryByText('未找到笔记')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: '添加' })).toBeDisabled()
    })

    it('shows an inline error naming the note when its content cannot be read', async () => {
      setPendingAddSource('note')
      mockProjectNotesTree.mockReturnValue([createNoteNode('Meeting notes', '/notes/Meeting notes.md')])
      mockReadExternal.mockRejectedValueOnce(new Error('ENOENT'))
      render(<AddKnowledgeItemDialog open onOpenChange={vi.fn()} />)

      fireEvent.click(screen.getByRole('checkbox', { name: /Meeting notes/ }))
      fireEvent.click(screen.getByRole('button', { name: '添加' }))

      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent('添加数据源失败: Meeting notes: ENOENT')
      expect(mockSubmitKnowledgeItems).not.toHaveBeenCalled()
    })
  })

  describe('note source — create mode', () => {
    const switchToCreateMode = () => fireEvent.click(screen.getByRole('radio', { name: '新建笔记' }))

    it('starts on the import list and swaps to the draft form on demand', () => {
      setPendingAddSource('note')
      mockProjectNotesTree.mockReturnValue([createNoteNode('Meeting notes', '/notes/Meeting notes.md')])
      render(<AddKnowledgeItemDialog open onOpenChange={vi.fn()} />)

      expect(screen.getByRole('radio', { name: '导入笔记' })).toHaveAttribute('aria-checked', 'true')
      expect(screen.getByText('Meeting notes')).toBeInTheDocument()
      expect(screen.queryByPlaceholderText('为这篇笔记取个名字')).not.toBeInTheDocument()

      switchToCreateMode()

      expect(screen.getByPlaceholderText('为这篇笔记取个名字')).toBeInTheDocument()
      expect(screen.getByPlaceholderText('在此输入笔记内容…')).toBeInTheDocument()
      expect(screen.getByPlaceholderText('在此输入笔记内容…')).toHaveAttribute('data-images-enabled', 'false')
      // The picker list is gone, so a stale pick cannot ride along with the draft.
      expect(screen.queryByText('Meeting notes')).not.toBeInTheDocument()
    })

    it('requires both a title and a body before the draft can be added', () => {
      setPendingAddSource('note')
      render(<AddKnowledgeItemDialog open onOpenChange={vi.fn()} />)
      switchToCreateMode()

      const addButton = screen.getByRole('button', { name: '添加' })
      expect(addButton).toBeDisabled()

      fireEvent.change(screen.getByPlaceholderText('为这篇笔记取个名字'), { target: { value: 'Ideas' } })
      expect(addButton).toBeDisabled()

      fireEvent.change(screen.getByPlaceholderText('在此输入笔记内容…'), { target: { value: 'body' } })
      expect(addButton).toBeEnabled()

      // Whitespace-only input is not a body.
      fireEvent.change(screen.getByPlaceholderText('在此输入笔记内容…'), { target: { value: '   ' } })
      expect(addButton).toBeDisabled()
    })

    it('rejects a whitespace-only title even with a real body', () => {
      setPendingAddSource('note')
      render(<AddKnowledgeItemDialog open onOpenChange={vi.fn()} />)
      switchToCreateMode()

      fireEvent.change(screen.getByPlaceholderText('在此输入笔记内容…'), { target: { value: 'body' } })
      // The title becomes the item's `source`, which the schema requires to be non-empty
      // *after* trimming — so spaces must not pass the gate.
      fireEvent.change(screen.getByPlaceholderText('为这篇笔记取个名字'), { target: { value: '   ' } })

      expect(screen.getByRole('button', { name: '添加' })).toBeDisabled()
    })

    it('submits the draft as a single note item with a trimmed title', async () => {
      setPendingAddSource('note')
      render(<AddKnowledgeItemDialog open onOpenChange={vi.fn()} />)
      switchToCreateMode()

      fireEvent.change(screen.getByPlaceholderText('为这篇笔记取个名字'), { target: { value: '  Ideas  ' } })
      fireEvent.change(screen.getByPlaceholderText('在此输入笔记内容…'), { target: { value: '# Ideas\n\nbody' } })
      fireEvent.click(screen.getByRole('button', { name: '添加' }))

      await waitFor(() => {
        expect(mockSubmitKnowledgeItems).toHaveBeenLastCalledWith(
          [{ type: 'note', data: { source: 'Ideas', content: '# Ideas\n\nbody' } }],
          'detect'
        )
      })
      // A drafted note never touches the notes directory.
      expect(mockReadExternal).not.toHaveBeenCalled()
    })

    it('ignores notes picked before the switch and keeps the footer count quiet', async () => {
      setPendingAddSource('note')
      mockProjectNotesTree.mockReturnValue([createNoteNode('Meeting notes', '/notes/Meeting notes.md')])
      render(<AddKnowledgeItemDialog open onOpenChange={vi.fn()} />)

      fireEvent.click(screen.getByRole('checkbox', { name: /Meeting notes/ }))
      expect(screen.getByText('已选 1 个笔记')).toBeInTheDocument()

      switchToCreateMode()

      expect(screen.queryByText('已选 1 个笔记')).not.toBeInTheDocument()

      fireEvent.change(screen.getByPlaceholderText('为这篇笔记取个名字'), { target: { value: 'Ideas' } })
      fireEvent.change(screen.getByPlaceholderText('在此输入笔记内容…'), { target: { value: 'body' } })
      fireEvent.click(screen.getByRole('button', { name: '添加' }))

      await waitFor(() => {
        expect(mockSubmitKnowledgeItems).toHaveBeenLastCalledWith(
          [{ type: 'note', data: { source: 'Ideas', content: 'body' } }],
          'detect'
        )
      })
    })

    it('keeps the panel open and the draft intact when the submit fails', async () => {
      setPendingAddSource('note')
      mockSubmitKnowledgeItems.mockRejectedValueOnce(new Error('create failed'))
      const onOpenChange = vi.fn()
      render(<AddKnowledgeItemDialog open onOpenChange={onOpenChange} />)
      switchToCreateMode()

      fireEvent.change(screen.getByPlaceholderText('为这篇笔记取个名字'), { target: { value: 'Ideas' } })
      fireEvent.change(screen.getByPlaceholderText('在此输入笔记内容…'), { target: { value: '# Ideas\n\nbody' } })
      fireEvent.click(screen.getByRole('button', { name: '添加' }))

      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent('添加数据源失败: create failed')
      // The draft is the only copy of what the user just wrote, so a failure must not
      // close the dialog or clear the form.
      expect(onOpenChange).not.toHaveBeenCalledWith(false)
      expect(screen.getByPlaceholderText('为这篇笔记取个名字')).toHaveValue('Ideas')
      expect(screen.getByPlaceholderText('在此输入笔记内容…')).toHaveValue('# Ideas\n\nbody')
      expect(toast.error).not.toHaveBeenCalled()
    })

    it('keeps the draft when switching modes back and forth', () => {
      setPendingAddSource('note')
      render(<AddKnowledgeItemDialog open onOpenChange={vi.fn()} />)
      switchToCreateMode()

      fireEvent.change(screen.getByPlaceholderText('为这篇笔记取个名字'), { target: { value: 'Ideas' } })
      fireEvent.change(screen.getByPlaceholderText('在此输入笔记内容…'), { target: { value: 'body' } })

      fireEvent.click(screen.getByRole('radio', { name: '导入笔记' }))
      switchToCreateMode()

      expect(screen.getByPlaceholderText('为这篇笔记取个名字')).toHaveValue('Ideas')
      expect(screen.getByPlaceholderText('在此输入笔记内容…')).toHaveValue('body')
    })
  })

  describe('url source (panel)', () => {
    it('enables url submit only after input', () => {
      setPendingAddSource('url')
      render(<AddKnowledgeItemDialog open onOpenChange={vi.fn()} />)

      expect(screen.getByRole('dialog')).toHaveAttribute('data-size', 'sm')
      expect(screen.getByRole('button', { name: '添加' })).toBeDisabled()
      fireEvent.change(screen.getByPlaceholderText('https://example.com'), {
        target: { value: 'https://example.com' }
      })
      expect(screen.getByRole('button', { name: '添加' })).toBeEnabled()
    })

    it('submits url source body through the generic hook, trimming the input', async () => {
      setPendingAddSource('url')
      render(<AddKnowledgeItemDialog open onOpenChange={vi.fn()} />)

      fireEvent.change(screen.getByPlaceholderText('https://example.com'), {
        target: { value: ' https://example.com ' }
      })
      fireEvent.click(screen.getByRole('button', { name: '添加' }))

      await waitFor(() => {
        expect(mockSubmitKnowledgeItems).toHaveBeenLastCalledWith(
          [{ type: 'url', data: { source: 'https://example.com', url: 'https://example.com' } }],
          'detect'
        )
      })
    })

    it('shows an inline error and keeps the panel open when the url submit fails', async () => {
      setPendingAddSource('url')
      mockSubmitKnowledgeItems.mockRejectedValueOnce(new Error('create failed'))
      const onOpenChange = vi.fn()
      render(<AddKnowledgeItemDialog open onOpenChange={onOpenChange} />)

      fireEvent.change(screen.getByPlaceholderText('https://example.com'), {
        target: { value: 'https://example.com' }
      })
      fireEvent.click(screen.getByRole('button', { name: '添加' }))

      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent('添加数据源失败: create failed')
      expect(toast.error).not.toHaveBeenCalled()
      expect(onOpenChange).not.toHaveBeenCalledWith(false)
    })
  })

  describe('same-name conflict resolution', () => {
    it('surfaces the conflict dialog after a file pick and resolves with keep all', async () => {
      mockFileSelect.mockResolvedValueOnce([createSelectedFile('alpha.pdf')])
      mockSubmitKnowledgeItems
        .mockResolvedValueOnce({ status: 'conflicts', conflicts: [{ type: 'file', title: 'alpha.pdf' }] })
        .mockResolvedValueOnce({ status: 'added' })
      const onOpenChange = vi.fn()
      render(<AddKnowledgeItemDialog open onOpenChange={onOpenChange} />)

      const keepAll = await screen.findByRole('button', { name: '全部保留' })
      expect(screen.getByText('存在同名数据源')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '替换' })).toBeInTheDocument()
      // The first pass is always a detect; nothing is added yet.
      expect(mockSubmitKnowledgeItems).toHaveBeenNthCalledWith(1, expect.any(Array), 'detect')
      expect(onOpenChange).not.toHaveBeenCalledWith(false)

      fireEvent.click(keepAll)

      await waitFor(() => {
        expect(mockSubmitKnowledgeItems).toHaveBeenNthCalledWith(2, expect.any(Array), 'rename')
      })
      await waitFor(() => {
        expect(onOpenChange).toHaveBeenCalledWith(false)
      })
    })

    it('resolves the conflict dialog with replace', async () => {
      mockFileSelect.mockResolvedValueOnce([createSelectedFile('alpha.pdf')])
      mockSubmitKnowledgeItems
        .mockResolvedValueOnce({ status: 'conflicts', conflicts: [{ type: 'file', title: 'alpha.pdf' }] })
        .mockResolvedValueOnce({ status: 'added' })
      const onOpenChange = vi.fn()
      render(<AddKnowledgeItemDialog open onOpenChange={onOpenChange} />)

      const replace = await screen.findByRole('button', { name: '替换' })
      fireEvent.click(replace)

      await waitFor(() => {
        expect(mockSubmitKnowledgeItems).toHaveBeenNthCalledWith(2, expect.any(Array), 'replace')
      })
      await waitFor(() => {
        expect(onOpenChange).toHaveBeenCalledWith(false)
      })
    })

    it('cancelling the conflict on a direct-pick source closes the whole flow', async () => {
      mockFileSelect.mockResolvedValueOnce([createSelectedFile('alpha.pdf')])
      mockSubmitKnowledgeItems.mockResolvedValueOnce({
        status: 'conflicts',
        conflicts: [{ type: 'file', title: 'alpha.pdf' }]
      })
      const onOpenChange = vi.fn()
      render(<AddKnowledgeItemDialog open onOpenChange={onOpenChange} />)

      fireEvent.click(await screen.findByRole('button', { name: '取消' }))

      await waitFor(() => {
        expect(onOpenChange).toHaveBeenCalledWith(false)
      })
      // Only the detect pass ran; nothing was added.
      expect(mockSubmitKnowledgeItems).toHaveBeenCalledTimes(1)
    })
  })
})

function createPdfSplitConfirmation() {
  return {
    token: 'split-token',
    expiresAt: '2026-08-10T08:10:00.000Z',
    processorId: 'doc2x',
    files: [
      {
        sourceName: 'alpha.pdf',
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
}
