import { Button, PageSidePanel } from '@cherrystudio/ui'
import { loggerService } from '@logger'
import { FilePreview } from '@renderer/components/FilePreview'
import {
  discardKnowledgePdfSplitConfirmation,
  type KnowledgeReindexSubmissionResult,
  useDeleteKnowledgeItem,
  useKnowledgeItems,
  useReindexKnowledgeItem
} from '@renderer/hooks/useKnowledgeItems'
import { formatErrorMessageWithPrefix } from '@renderer/utils/error'
import type { KnowledgeItem, KnowledgeItemOf, KnowledgePdfSplitConfirmation } from '@shared/data/types/knowledge'
import { ArrowLeft } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import DetailHeader from '../components/DetailHeader'
import PdfSplitConfirmationDialog from '../components/PdfSplitConfirmationDialog'
import { useKnowledgePage } from '../KnowledgePageProvider'
import DataSourcePanel from '../panels/dataSource/DataSourcePanel'
import KnowledgeItemChunkDetailPanel from '../panels/dataSource/KnowledgeItemChunkDetailPanel'
import KnowledgeItemNoteContentPanel from '../panels/dataSource/KnowledgeItemNoteContentPanel'
import RagConfigPanel from '../panels/ragConfig/RagConfigPanel'
import RecallTestPanel from '../panels/recallTest/RecallTestPanel'

const logger = loggerService.withContext('KnowledgePageDetailSection')

interface PendingReindexPdfSplit {
  confirmation: KnowledgePdfSplitConfirmation
  itemIds: string[]
  remainingItemIds: string[]
}

const KnowledgePageDetailSection = () => {
  const { t } = useTranslation()
  const {
    selectedBase,
    selectedBaseId,
    selectedItemId,
    selectedItemView,
    filePreview,
    baseNavigationVersion,
    isRagConfigDrawerOpen,
    isRecallTestDrawerOpen,
    openItemChunks,
    openItemContent,
    closeItemChunks,
    openFilePreview,
    closeFilePreview,
    openAddSourceDialog,
    openRagConfigDrawer,
    openRecallTestDrawer,
    handleRagConfigDrawerOpenChange,
    handleRecallTestDrawerOpenChange,
    openRestoreBaseDialog
  } = useKnowledgePage()

  // Directory drill-down: the stack holds the directory items descended into (empty = base root).
  // The current directory's id becomes the item-list's `groupId`, listing that folder's children.
  const [directoryStack, setDirectoryStack] = useState<KnowledgeItemOf<'directory'>[]>([])
  const [pendingReindexPdfSplit, setPendingReindexPdfSplit] = useState<PendingReindexPdfSplit | null>(null)
  const [reindexPdfSplitError, setReindexPdfSplitError] = useState('')
  const [isConfirmingReindexPdfSplit, setIsConfirmingReindexPdfSplit] = useState(false)
  const currentDirectory = directoryStack.at(-1) ?? null

  // Every base selection starts from that base's root, including re-selecting the current base.
  useEffect(() => {
    setDirectoryStack([])
  }, [baseNavigationVersion])

  const drillIntoDirectory = useCallback((item: KnowledgeItemOf<'directory'>) => {
    setDirectoryStack((prev) => [...prev, item])
  }, [])
  const navigateUp = useCallback(() => {
    setDirectoryStack((prev) => prev.slice(0, -1))
  }, [])

  const {
    items: selectedBaseItems,
    total: selectedBaseItemsTotal,
    isLoading: isItemsLoading,
    hasMore: hasMoreItems,
    isLoadingMore: isLoadingMoreItems,
    loadMore: loadMoreItems
  } = useKnowledgeItems(selectedBaseId, currentDirectory?.id ?? null)
  const { deleteItem, deleteItems } = useDeleteKnowledgeItem(selectedBaseId)
  const { reindexItems } = useReindexKnowledgeItem(selectedBaseId)

  const captureReindexResult = useCallback((result: KnowledgeReindexSubmissionResult): boolean => {
    if (result.status !== 'split_confirmation_required') return false
    setReindexPdfSplitError('')
    setPendingReindexPdfSplit({
      confirmation: result.confirmation,
      itemIds: result.itemIds,
      remainingItemIds: result.remainingItemIds
    })
    return true
  }, [])

  const requestReindexItems = useCallback(
    async (itemIds: string[]) => {
      captureReindexResult(await reindexItems(itemIds))
    },
    [captureReindexResult, reindexItems]
  )

  const requestReindexItem = useCallback(
    async (item: KnowledgeItem) => {
      await requestReindexItems([item.id])
    },
    [requestReindexItems]
  )

  const handleConfirmReindexPdfSplit = useCallback(() => {
    if (!pendingReindexPdfSplit || isConfirmingReindexPdfSplit) return
    setReindexPdfSplitError('')
    setIsConfirmingReindexPdfSplit(true)
    void (async () => {
      const confirmedResult = await reindexItems(
        pendingReindexPdfSplit.itemIds,
        pendingReindexPdfSplit.confirmation.token
      )
      if (captureReindexResult(confirmedResult)) return

      if (pendingReindexPdfSplit.remainingItemIds.length > 0) {
        const remainingResult = await reindexItems(pendingReindexPdfSplit.remainingItemIds)
        if (captureReindexResult(remainingResult)) return
      }
      setPendingReindexPdfSplit(null)
    })()
      .catch((error) => {
        setReindexPdfSplitError(formatErrorMessageWithPrefix(error, t('knowledge.data_source.reindex_failed')))
      })
      .finally(() => setIsConfirmingReindexPdfSplit(false))
  }, [captureReindexResult, isConfirmingReindexPdfSplit, pendingReindexPdfSplit, reindexItems, t])

  const handleCancelReindexPdfSplit = useCallback(() => {
    if (!pendingReindexPdfSplit || isConfirmingReindexPdfSplit) return
    const token = pendingReindexPdfSplit.confirmation.token
    setPendingReindexPdfSplit(null)
    setReindexPdfSplitError('')
    void discardKnowledgePdfSplitConfirmation(token).catch((error) => {
      logger.warn('Failed to discard reindex PDF split confirmation', {
        token,
        error: error instanceof Error ? error.message : String(error)
      })
    })
  }, [isConfirmingReindexPdfSplit, pendingReindexPdfSplit])

  if (!selectedBase) {
    return null
  }

  return (
    <main data-ui="knowledge.content" className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {!selectedItemId && !filePreview ? (
        <DetailHeader
          base={selectedBase}
          onOpenRagConfig={openRagConfigDrawer}
          onOpenRecallTest={openRecallTestDrawer}
          onRebuild={() => openRestoreBaseDialog(selectedBase)}
        />
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden">
        {selectedItemId ? (
          selectedItemView === 'content' ? (
            <KnowledgeItemNoteContentPanel itemId={selectedItemId} onBack={closeItemChunks} />
          ) : (
            <KnowledgeItemChunkDetailPanel baseId={selectedBaseId} itemId={selectedItemId} onBack={closeItemChunks} />
          )
        ) : filePreview ? (
          <section
            aria-label={filePreview.fileName}
            className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <FilePreview
              filePath={filePreview.filePath}
              header={
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('common.back')}
                    className="size-6 min-h-6 min-w-6 rounded p-0 text-muted-foreground shadow-none hover:bg-accent hover:text-foreground"
                    onClick={closeFilePreview}>
                    <ArrowLeft className="size-3.5" />
                  </Button>
                  <span className="min-w-0 flex-1 truncate text-foreground text-sm">{filePreview.fileName}</span>
                </>
              }
            />
          </section>
        ) : (
          <DataSourcePanel
            embeddingModelId={selectedBase.embeddingModelId}
            items={selectedBaseItems}
            total={selectedBaseItemsTotal}
            isLoading={isItemsLoading}
            hasMore={hasMoreItems}
            isLoadingMore={isLoadingMoreItems}
            onLoadMore={loadMoreItems}
            updatedAt={selectedBase.updatedAt}
            onAdd={openAddSourceDialog}
            onPreviewFile={openFilePreview}
            onItemClick={openItemChunks}
            onViewNoteContent={openItemContent}
            onDrillIntoDirectory={drillIntoDirectory}
            currentDirectory={currentDirectory}
            onNavigateUp={navigateUp}
            onDelete={deleteItem}
            onDeleteItems={deleteItems}
            onReindex={requestReindexItem}
            onReindexItems={requestReindexItems}
          />
        )}
      </div>

      <PageSidePanel
        open={isRagConfigDrawerOpen}
        onClose={() => handleRagConfigDrawerOpenChange(false)}
        title={t('knowledge.tabs.rag_config')}
        closeLabel={t('common.close')}
        bodyClassName="px-0 py-0">
        <RagConfigPanel
          base={selectedBase}
          itemCount={isItemsLoading ? undefined : selectedBaseItemsTotal}
          onRestoreBase={openRestoreBaseDialog}
        />
      </PageSidePanel>

      <PageSidePanel
        open={isRecallTestDrawerOpen}
        onClose={() => handleRecallTestDrawerOpenChange(false)}
        title={t('knowledge.tabs.recall_test')}
        closeLabel={t('common.close')}
        bodyClassName="px-0 py-0">
        <RecallTestPanel baseId={selectedBaseId} />
      </PageSidePanel>

      <PdfSplitConfirmationDialog
        state={
          pendingReindexPdfSplit
            ? { status: 'ready', confirmation: pendingReindexPdfSplit.confirmation }
            : { status: 'closed' }
        }
        errorMessage={reindexPdfSplitError}
        isConfirming={isConfirmingReindexPdfSplit}
        onConfirm={handleConfirmReindexPdfSplit}
        onCancel={handleCancelReindexPdfSplit}
      />
    </main>
  )
}

export default KnowledgePageDetailSection
