import { useReindexKnowledgeItem } from '@renderer/hooks/useKnowledgeItems'
import { createNoteItem } from '@renderer/pages/knowledge/panels/dataSource/__tests__/testUtils'
import { mockRendererLoggerService } from '@test-mocks/RendererLoggerService'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseInvalidateCache = vi.fn()
const mockInvalidateCache = vi.fn()
const mockIpcRequest = vi.fn()
let loggerErrorSpy: ReturnType<typeof vi.spyOn>

vi.mock('@data/hooks/useDataApi', () => ({
  useInvalidateCache: () => mockUseInvalidateCache()
}))

vi.mock('@renderer/ipc', () => ({
  ipcApi: {
    request: (...args: unknown[]) => mockIpcRequest(...args)
  }
}))

describe('useReindexKnowledgeItem', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    loggerErrorSpy = vi.spyOn(mockRendererLoggerService, 'error').mockImplementation(() => {})
    mockUseInvalidateCache.mockReturnValue(mockInvalidateCache)
    mockInvalidateCache.mockResolvedValue(undefined)
    mockIpcRequest.mockResolvedValue({ status: 'scheduled' })
  })

  it('reindexes one knowledge item through orchestration IPC and refreshes the list', async () => {
    const item = createNoteItem({ id: 'note-1', content: '会议纪要' })
    const { result } = renderHook(() => useReindexKnowledgeItem('base-1'))

    await act(async () => {
      await expect(result.current.reindexItem(item)).resolves.toEqual({ status: 'scheduled' })
    })

    expect(mockIpcRequest).toHaveBeenCalledWith('knowledge.reindex_items', { baseId: 'base-1', itemIds: ['note-1'] })
    expect(mockInvalidateCache).toHaveBeenCalledWith(['/knowledge-bases/base-1/items', '/knowledge-bases'])
    expect(mockIpcRequest.mock.invocationCallOrder[0]).toBeLessThan(mockInvalidateCache.mock.invocationCallOrder[0])
    expect(result.current.error).toBeUndefined()
    expect(result.current.isReindexing).toBe(false)
  })

  it('reindexes multiple knowledge items through one orchestration IPC request and one cache refresh', async () => {
    const { result } = renderHook(() => useReindexKnowledgeItem('base-1'))

    await act(async () => {
      await expect(result.current.reindexItems(['note-1', 'note-2'])).resolves.toEqual({ status: 'scheduled' })
    })

    expect(mockIpcRequest).toHaveBeenCalledTimes(1)
    expect(mockIpcRequest).toHaveBeenCalledWith('knowledge.reindex_items', {
      baseId: 'base-1',
      itemIds: ['note-1', 'note-2']
    })
    expect(mockInvalidateCache).toHaveBeenCalledTimes(1)
    expect(mockInvalidateCache).toHaveBeenCalledWith(['/knowledge-bases/base-1/items', '/knowledge-bases'])
  })

  it('splits more than 100 items into valid orchestration batches and refreshes once', async () => {
    const itemIds = Array.from({ length: 101 }, (_, index) => `note-${index + 1}`)
    const { result } = renderHook(() => useReindexKnowledgeItem('base-1'))

    await act(async () => {
      await expect(result.current.reindexItems(itemIds)).resolves.toEqual({ status: 'scheduled' })
    })

    expect(mockIpcRequest).toHaveBeenCalledTimes(2)
    expect(mockIpcRequest).toHaveBeenNthCalledWith(1, 'knowledge.reindex_items', {
      baseId: 'base-1',
      itemIds: itemIds.slice(0, 100)
    })
    expect(mockIpcRequest).toHaveBeenNthCalledWith(2, 'knowledge.reindex_items', {
      baseId: 'base-1',
      itemIds: itemIds.slice(100)
    })
    expect(mockInvalidateCache).toHaveBeenCalledTimes(1)
    expect(mockIpcRequest.mock.invocationCallOrder[1]).toBeLessThan(mockInvalidateCache.mock.invocationCallOrder[0])
  })

  it('returns the exact confirmation batch and remaining ids without refreshing', async () => {
    const itemIds = Array.from({ length: 101 }, (_, index) => `note-${index + 1}`)
    const confirmation = {
      token: 'split-token',
      expiresAt: '2026-08-10T08:10:00.000Z',
      processorId: 'doc2x',
      files: [
        {
          sourceName: 'report.pdf',
          pageCount: 31,
          sourceBytes: 1024,
          parts: [{ pageStart: 1, pageEnd: 31, bytes: 1024 }]
        }
      ],
      totalTasks: 1,
      estimatedDiskBytes: 1024
    }
    mockIpcRequest.mockResolvedValueOnce({ status: 'split_confirmation_required', confirmation })
    const { result } = renderHook(() => useReindexKnowledgeItem('base-1'))

    await act(async () => {
      await expect(result.current.reindexItems(itemIds)).resolves.toEqual({
        status: 'split_confirmation_required',
        confirmation,
        itemIds: itemIds.slice(0, 100),
        remainingItemIds: itemIds.slice(100)
      })
    })

    expect(mockIpcRequest).toHaveBeenCalledTimes(1)
    expect(mockInvalidateCache).not.toHaveBeenCalled()
  })

  it('sends the confirmation token when retrying its reindex batch', async () => {
    const { result } = renderHook(() => useReindexKnowledgeItem('base-1'))

    await act(async () => {
      await expect(result.current.reindexItems(['note-1'], 'split-token')).resolves.toEqual({ status: 'scheduled' })
    })

    expect(mockIpcRequest).toHaveBeenCalledWith('knowledge.reindex_items', {
      baseId: 'base-1',
      itemIds: ['note-1'],
      splitConfirmationToken: 'split-token'
    })
  })

  it('keeps reindex rejected, refreshes items, and exposes inline error when orchestration rejects', async () => {
    const reindexError = new Error('reindex failed')
    const item = createNoteItem({ id: 'note-1', content: '会议纪要' })
    mockIpcRequest.mockRejectedValueOnce(reindexError)
    const { result } = renderHook(() => useReindexKnowledgeItem('base-1'))

    await act(async () => {
      await expect(result.current.reindexItem(item)).rejects.toBe(reindexError)
    })

    expect(mockInvalidateCache).toHaveBeenCalledWith(['/knowledge-bases/base-1/items', '/knowledge-bases'])
    expect(mockIpcRequest.mock.invocationCallOrder[0]).toBeLessThan(mockInvalidateCache.mock.invocationCallOrder[0])
    expect(result.current.error).toBe(reindexError)
    expect(result.current.isReindexing).toBe(false)
    expect(loggerErrorSpy).toHaveBeenCalledWith('Failed to reindex knowledge source', reindexError, {
      baseId: 'base-1',
      itemIds: ['note-1']
    })
  })
})
