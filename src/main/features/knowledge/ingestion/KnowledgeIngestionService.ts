import '../tasks/jobTypes'

import path from 'node:path'

import { application } from '@application'
import { knowledgeBaseService } from '@data/services/KnowledgeBaseService'
import { knowledgeItemService } from '@data/services/KnowledgeItemService'
import { loggerService } from '@logger'
import type { KeyedMutex } from '@main/core/concurrency/KeyedMutex'
import { FILE_PROCESSING_JOB_TYPES } from '@main/features/fileProcessing'
import { nextFreeKnowledgeRelativePath } from '@main/utils/knowledge'
import { getFileExt } from '@main/utils/legacyFile'
import { DataApiErrorFactory } from '@shared/data/api/errors'
import type { UpdateKnowledgeBaseDto } from '@shared/data/api/schemas/knowledges'
import { FileProcessorIdSchema } from '@shared/data/presets/fileProcessing'
import {
  type CreateKnowledgeItemDto,
  DEFAULT_KNOWLEDGE_ADD_CONFLICT_STRATEGY,
  KNOWLEDGE_ITEM_ERROR_INDEXING_INTERRUPTED,
  type KnowledgeAddConflictStrategy,
  type KnowledgeAddItemInput,
  KnowledgeAddItemInputSchema,
  type KnowledgeAddItemsResult,
  type KnowledgeBase,
  type KnowledgeItem,
  type KnowledgeItemOf,
  type KnowledgeItemStatus,
  type KnowledgePdfSplitConfirmation,
  type KnowledgeReindexItemsResult
} from '@shared/data/types/knowledge'
import { knowledgeSupportedFileExts, type PosixRelativeFilePath } from '@shared/utils/file'

import { assertBaseCanRunRuntimeOperation } from '../base/baseGuards'
import { classifyKnowledgeItemSource } from '../items'
import {
  assertKnowledgeFileTargetAvailable,
  assertSafeKnowledgeRelativePath,
  collectKnowledgeReservedRelativePaths,
  copyFileIntoKnowledgeBaseAt,
  deleteKnowledgeItemFilesBestEffort,
  getKnowledgeBaseFilePath,
  getKnowledgeSourceRelativePath,
  getProcessedMarkdownRelativePath,
  needsProcessedArtifactReservation,
  reserveImportedFileRelativePath
} from '../pathStorage'
import { planKnowledgeItemSource } from '../pipeline/sources/sourcePlanning'
import { deleteKnowledgeItemVectors } from '../pipeline/vectorstore/vectorCleanup'
import { cancelActiveKnowledgeJobs, cancelJobOrThrow } from '../tasks/utils/cancel'
import {
  type KnowledgeBaseId,
  knowledgeDeleteSubtreeIdempotencyKey,
  knowledgeFileProcessingCheckIdempotencyKey,
  knowledgeIndexIdempotencyKey,
  type KnowledgeItemId,
  knowledgePrepareIdempotencyKey,
  knowledgeQueueName,
  knowledgeReindexSubtreeIdempotencyKey,
  toKnowledgeBaseId,
  toKnowledgeItemId,
  toKnowledgeItemIds
} from '../types'
import { resolveKnowledgeAddConflicts } from './addConflicts'
import { pdfSplitService } from './pdfSplit/PdfSplitService'
import type { PdfSplitBundle, StagedPdfSplit } from './pdfSplit/types'
import { markUnscheduledKnowledgeItemsFailed } from './statusCleanup'
import { purgeKnowledgeSubtreeWithinLock } from './subtreePurge'

const logger = loggerService.withContext('Knowledge:IngestionService')
// Keep poll jobs delayed enough to avoid hot-looping while remote processors are still working.
const FILE_PROCESSING_PENDING_CHECK_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 5 * 60_000] as const
const KNOWLEDGE_SUPPORTED_FILE_EXT_SET = new Set<string>(knowledgeSupportedFileExts)
const REINDEX_ALLOWED_STATUSES = new Set<KnowledgeItemStatus>(['completed', 'failed'])
const DELETE_RECOVERY_ROOT_CHUNK_SIZE = 500

/**
 * The workflow re-entry seam job handlers call back into (workflow-architecture.md): expand a
 * container, index a leaf, or poll a file-processing job. Handlers depend on exactly this surface,
 * not the full `KnowledgeIngestionService`.
 */
export interface KnowledgeItemScheduler {
  scheduleItem(
    baseId: KnowledgeBaseId,
    itemId: KnowledgeItemId,
    parentJobId?: string | null,
    options?: { forceFileProcessing?: boolean }
  ): Promise<void>
  scheduleIndexing(baseId: KnowledgeBaseId, itemId: KnowledgeItemId, parentJobId?: string | null): Promise<void>
  scheduleFileProcessingCheck(
    baseId: KnowledgeBaseId,
    itemId: KnowledgeItemId,
    fileProcessingJobId: string,
    options: {
      pollRound: number
      firstScheduledAt: number
      parentJobId: string | null
      processedRelativePath: string
      delayMs?: number
    }
  ): Promise<void>
}

/** Write-side orchestration: admission checks, item creation, conflict handling, and job enqueueing for the add/delete/reindex flows. */
export class KnowledgeIngestionService implements KnowledgeItemScheduler {
  constructor(private readonly knowledgeLockManager: KeyedMutex) {}

  async preflightPdfSplitAdd(baseId: string, filePath: string): Promise<KnowledgePdfSplitConfirmation | null> {
    const base = assertBaseCanRunRuntimeOperation(baseId, 'preflightPdfSplitAdd')
    if (!base.fileProcessorId) return null

    const input = KnowledgeAddItemInputSchema.parse({
      type: 'file',
      data: { source: path.basename(filePath), path: filePath }
    })
    return await pdfSplitService.preflightAdd({
      baseId: base.id,
      processorId: FileProcessorIdSchema.parse(base.fileProcessorId),
      inputs: [input],
      conflictStrategy: DEFAULT_KNOWLEDGE_ADD_CONFLICT_STRATEGY
    })
  }

  async addItems(
    baseId: string,
    inputs: KnowledgeAddItemInput[],
    conflictStrategy: KnowledgeAddConflictStrategy = DEFAULT_KNOWLEDGE_ADD_CONFLICT_STRATEGY,
    splitConfirmationToken?: string
  ): Promise<KnowledgeAddItemsResult> {
    return await this.addItemsInternal(baseId, inputs, conflictStrategy, splitConfirmationToken)
  }

  async addRestoredItems(
    baseId: string,
    inputs: KnowledgeAddItemInput[],
    splitBundle: PdfSplitBundle | null
  ): Promise<void> {
    if (splitBundle && splitBundle.operation !== 'restore') {
      throw new Error(`Expected a restore PDF split bundle, received '${splitBundle.operation}'`)
    }
    const result = await this.addItemsInternal(baseId, inputs, DEFAULT_KNOWLEDGE_ADD_CONFLICT_STRATEGY, undefined, {
      splitBundle,
      skipPdfSplitPreflight: true
    })
    if (result.status !== 'added') {
      throw new Error(`Restore item acceptance returned unexpected status '${result.status}'`)
    }
  }

  private async addItemsInternal(
    baseId: string,
    inputs: KnowledgeAddItemInput[],
    conflictStrategy: KnowledgeAddConflictStrategy,
    splitConfirmationToken?: string,
    options: { splitBundle: PdfSplitBundle | null; skipPdfSplitPreflight: boolean } = {
      splitBundle: null,
      skipPdfSplitPreflight: false
    }
  ): Promise<KnowledgeAddItemsResult> {
    const base = assertBaseCanRunRuntimeOperation(baseId, 'addItems')

    if (inputs.length === 0) {
      return { status: 'added' }
    }

    // rename (the default, and every internal caller — restore/migrator): keep all,
    // auto-rename on collision. detect/replace first resolve same-name conflicts
    // against the existing root items and earlier items in the same batch.
    let itemsToAdd = inputs
    let conflictingExistingRootIds: string[] = []
    if (conflictStrategy !== 'rename') {
      const existingRoots = knowledgeItemService.getRootItemsByBaseId(base.id)
      const resolution = resolveKnowledgeAddConflicts(inputs, existingRoots)
      if (conflictStrategy === 'detect') {
        if (resolution.conflicts.length > 0) {
          // Report and add nothing — the UI asks the user how to resolve.
          return { status: 'conflicts', conflicts: resolution.conflicts }
        }
      } else {
        // replace: incoming sources win. Drop earlier same-name batch items (last
        // wins) and cancel any in-flight job on the conflicting existing subtrees
        // BEFORE taking the lock — cancel awaits handler settlement and the
        // index/prepare handlers take this same base lock, so cancelling while
        // holding it would deadlock.
        itemsToAdd = resolution.keptInputs
        conflictingExistingRootIds = resolution.conflictingExistingRootIds
      }
    }

    let splitBundle = options.splitBundle
    if (base.fileProcessorId && !options.skipPdfSplitPreflight) {
      const processorId = FileProcessorIdSchema.parse(base.fileProcessorId)
      const splitRequest = { baseId: base.id, processorId, inputs: itemsToAdd, conflictStrategy }
      if (splitConfirmationToken) {
        splitBundle = await pdfSplitService.confirmAdd(splitRequest, splitConfirmationToken)
      } else {
        const confirmation = await pdfSplitService.preflightAdd(splitRequest)
        if (confirmation) {
          return { status: 'split_confirmation_required', confirmation }
        }
      }
    }

    if (conflictingExistingRootIds.length > 0) {
      try {
        await cancelActiveKnowledgeJobs(base.id, 'knowledge-add-replace', {
          rootItemIds: conflictingExistingRootIds,
          onCancelTimeout: 'throw'
        })
      } catch (error) {
        if (splitBundle) await pdfSplitService.discard(splitBundle.token)
        throw error
      }
    }

    const acceptedItems: KnowledgeItem[] = []
    const schedulingItems: KnowledgeItem[] = []
    const copiedFileItems: Array<Pick<CreateKnowledgeItemDto, 'type' | 'data'>> = []
    const boundDirectoryItemIds: string[] = []

    await this.knowledgeLockManager.runExclusive(base.id, async () => {
      try {
        if (splitBundle) {
          await pdfSplitService.assertBundleDirectoriesCurrent(splitBundle)
        }
        if (conflictStrategy === 'replace') {
          // Purge the conflicting existing items synchronously inside the lock and
          // BEFORE reserving paths, so the freed name is claimed by the incoming
          // source instead of being auto-renamed with a numeric suffix.
          await this.purgeConflictingExistingItems(base, itemsToAdd)
        }

        // Reserve every existing on-disk path up front, then let each new file
        // claim a collision-free name (auto-renaming with a numeric suffix)
        // against the same growing set, so a same-named batch add no longer
        // throws — earlier inputs are visible when deduping later ones.
        const reservedPaths = this.loadReservedKnowledgeFilePaths(base.id, base.fileProcessorId)
        for (const [inputIndex, input] of itemsToAdd.entries()) {
          const directSplit = splitBundle?.splits.find(
            (split) => split.owner.kind === 'add-file' && split.owner.inputIndex === inputIndex
          )
          if (directSplit && input.type === 'file') {
            const relativePrefix = reservePdfSplitDirectoryRelativePath(input.data.path, reservedPaths)
            const published = await pdfSplitService.publishStagedSplit(base.id, directSplit, relativePrefix)
            const created = knowledgeItemService.createPdfSplitSubtree(base.id, {
              groupId: input.groupId,
              data: {
                source: input.data.source,
                relativePath: relativePrefix,
                pdfSplitSource: {
                  relativePath: published.sourceRelativePath,
                  sourceName: path.basename(input.data.path),
                  totalPages: directSplit.pageCount
                }
              },
              parts: toPdfPartData(published.parts)
            })
            acceptedItems.push(created.parent)
            schedulingItems.push(...created.parts)
            copiedFileItems.push(created.parent)
            continue
          }

          const createInput = await this.prepareRuntimeAddItemInput(base.id, base.fileProcessorId, input, reservedPaths)
          // A url restore copies its snapshot to raw/{relativePath} under type 'url',
          // so track it for rollback too — otherwise a mid-batch failure orphans the
          // snapshot and a same-titled re-restore later hard-fails on the leftover file
          // (the add-side twin of the delete-side leak fixed in deleteKnowledgeItemFiles).
          if (createInput.type === 'file' || (createInput.type === 'url' && createInput.data.relativePath)) {
            copiedFileItems.push(createInput)
          }
          const createdItem = knowledgeItemService.createActive(base.id, createInput)
          acceptedItems.push(createdItem)
          schedulingItems.push(createdItem)
          const directorySplits =
            splitBundle?.splits.filter(
              (split) => split.owner.kind === 'add-directory' && split.owner.inputIndex === inputIndex
            ) ?? []
          const directoryPlan = splitBundle?.directoryPlans.find(
            (plan) => plan.owner.kind === 'add-directory' && plan.owner.inputIndex === inputIndex
          )
          if (createdItem.type === 'directory' && (directoryPlan || directorySplits.length > 0)) {
            await pdfSplitService.bindDirectoryBundle(createdItem.id, directorySplits, directoryPlan)
            boundDirectoryItemIds.push(createdItem.id)
          }
        }
      } catch (error) {
        this.rollbackAcceptedItems(base.id, acceptedItems, error)
        // Best-effort cleanup so a failed delete (EACCES/EBUSY/...) cannot
        // mask the original error that triggered the rollback.
        await deleteKnowledgeItemFilesBestEffort(base.id, copiedFileItems, {
          baseId: base.id,
          addError: error instanceof Error ? error.message : String(error)
        })
        await Promise.all(boundDirectoryItemIds.map((itemId) => pdfSplitService.discardDirectorySplits(itemId)))
        if (splitBundle) await pdfSplitService.discard(splitBundle.token)
        throw error
      }
    })

    if (splitBundle) {
      await pdfSplitService.discard(splitBundle.token)
    }

    const completedSchedulingItemIds = new Set<string>()
    try {
      for (const item of schedulingItems) {
        await this.scheduleItem(toKnowledgeBaseId(item.baseId), toKnowledgeItemId(item.id))
        completedSchedulingItemIds.add(item.id)
      }
    } catch (error) {
      this.markUnscheduledAcceptedItemsFailed(base.id, schedulingItems, completedSchedulingItemIds, error)
      await Promise.all(
        boundDirectoryItemIds
          .filter((itemId) => !completedSchedulingItemIds.has(itemId))
          .map((itemId) => pdfSplitService.discardDirectorySplits(itemId))
      )
      throw error
    }

    return { status: 'added' }
  }

  /**
   * Remove the existing root items (and their subtrees) whose name an incoming
   * source collides with, for the `replace` strategy. MUST run inside the base
   * mutation lock. Re-resolves conflicts against the current roots so a change in
   * the cancel->lock gap is honored; the in-flight jobs were already cancelled by
   * the caller outside the lock.
   */
  private async purgeConflictingExistingItems(base: KnowledgeBase, itemsToAdd: KnowledgeAddItemInput[]): Promise<void> {
    const currentRoots = knowledgeItemService.getRootItemsByBaseId(base.id)
    const { conflictingExistingRootIds } = resolveKnowledgeAddConflicts(itemsToAdd, currentRoots)
    if (conflictingExistingRootIds.length === 0) {
      return
    }
    const subtreeItems = knowledgeItemService.getSubtreeItems(base.id, conflictingExistingRootIds, {
      includeRoots: true
    })
    await purgeKnowledgeSubtreeWithinLock(base, subtreeItems, { baseId: base.id, reason: 'knowledge-add-replace' })
  }

  async deleteItems(baseId: string, itemIds: string[]): Promise<void> {
    const rootItemIds = knowledgeItemService.getOutermostSelectedItemIds(baseId, itemIds)
    if (rootItemIds.length === 0) {
      return
    }

    const rootItems = knowledgeItemService
      .getSubtreeItems(baseId, rootItemIds, { includeRoots: true })
      .filter((item) => rootItemIds.includes(item.id))
    if (rootItems.some((item) => item.type === 'file' && item.data.pdfPart)) {
      throw DataApiErrorFactory.validation(
        { item: ['Managed PDF parts cannot be deleted individually'] },
        'Delete the split PDF directory to remove all of its parts'
      )
    }

    knowledgeBaseService.getById(baseId)
    const knowledgeBaseId = toKnowledgeBaseId(baseId)
    const knowledgeRootItemIds = toKnowledgeItemIds(rootItemIds)
    await this.knowledgeLockManager.runExclusive(baseId, () =>
      application.get('DbService').withWriteTx((tx) => {
        knowledgeItemService.setSubtreeStatusTx(tx, baseId, rootItemIds, 'deleting')
        application.get('JobManager').enqueueTx(
          tx,
          'knowledge.delete-subtree',
          { baseId, rootItemIds },
          {
            idempotencyKey: knowledgeDeleteSubtreeIdempotencyKey(knowledgeBaseId, knowledgeRootItemIds),
            queue: knowledgeQueueName(knowledgeBaseId)
          }
        )
      })
    )
  }

  async reindexItems(
    baseId: string,
    itemIds: string[],
    splitConfirmationToken?: string,
    skipPdfSplitPreflight = false
  ): Promise<KnowledgeReindexItemsResult> {
    const base = assertBaseCanRunRuntimeOperation(baseId, 'reindexItems')
    const rootItemIds = knowledgeItemService.getOutermostSelectedItemIds(baseId, itemIds)
    if (rootItemIds.length === 0) {
      return { status: 'scheduled' }
    }

    await this.assertSubtreesCanReindex(baseId, rootItemIds)

    const selectedSubtree = knowledgeItemService.getSubtreeItems(baseId, rootItemIds, { includeRoots: true })
    const rootItems = selectedSubtree.filter((item) => rootItemIds.includes(item.id))
    let splitBundle: PdfSplitBundle | null = null
    if (base.fileProcessorId && !skipPdfSplitPreflight) {
      const processorId = FileProcessorIdSchema.parse(base.fileProcessorId)
      const splitRequest = { baseId, processorId, rootItems }
      if (splitConfirmationToken) {
        splitBundle = await pdfSplitService.confirmReindex(splitRequest, splitConfirmationToken)
      } else {
        const confirmation = await pdfSplitService.preflightReindex(splitRequest)
        if (confirmation) return { status: 'split_confirmation_required', confirmation }
      }
    }

    const convertedRootIds = new Set<string>()
    const boundDirectoryItemIds: string[] = []
    try {
      if (splitBundle) {
        await pdfSplitService.assertBundleDirectoriesCurrent(splitBundle)
        const directorySplitsByItemId = new Map<string, StagedPdfSplit[]>()
        for (const split of splitBundle.splits) {
          if (split.owner.kind === 'reindex-directory') {
            const existing = directorySplitsByItemId.get(split.owner.itemId) ?? []
            existing.push(split)
            directorySplitsByItemId.set(split.owner.itemId, existing)
          }
        }
        const directoryItemIds = new Set([
          ...directorySplitsByItemId.keys(),
          ...splitBundle.directoryPlans.flatMap((plan) =>
            plan.owner.kind === 'reindex-directory' ? [plan.owner.itemId] : []
          )
        ])
        for (const itemId of directoryItemIds) {
          const plan = splitBundle.directoryPlans.find(
            (candidate) => candidate.owner.kind === 'reindex-directory' && candidate.owner.itemId === itemId
          )
          await pdfSplitService.bindDirectoryBundle(itemId, directorySplitsByItemId.get(itemId) ?? [], plan)
          boundDirectoryItemIds.push(itemId)
        }

        const fileConversions = splitBundle.splits.filter(
          (split): split is StagedPdfSplit & { owner: { kind: 'reindex-file'; itemId: string } } =>
            split.owner.kind === 'reindex-file'
        )
        for (const split of fileConversions) {
          const item = rootItems.find(
            (candidate): candidate is KnowledgeItemOf<'file'> =>
              candidate.id === split.owner.itemId && candidate.type === 'file'
          )
          if (!item) throw new Error(`PDF reindex source item not found: ${split.owner.itemId}`)
          await this.convertFileToPdfSplit(base, item, split)
          convertedRootIds.add(item.id)
        }
        await pdfSplitService.discard(splitBundle.token)
      }

      const rootsToSchedule = rootItemIds.filter((itemId) => !convertedRootIds.has(itemId))
      if (rootsToSchedule.length === 0) return { status: 'scheduled' }

      const knowledgeBaseId = toKnowledgeBaseId(baseId)
      const knowledgeRootItemIds = toKnowledgeItemIds(rootsToSchedule)
      const jobManager = application.get('JobManager')
      jobManager.enqueue(
        'knowledge.reindex-subtree',
        { baseId, rootItemIds: rootsToSchedule },
        {
          idempotencyKey: knowledgeReindexSubtreeIdempotencyKey(knowledgeBaseId, knowledgeRootItemIds),
          queue: knowledgeQueueName(knowledgeBaseId)
        }
      )
      return { status: 'scheduled' }
    } catch (error) {
      await Promise.all(boundDirectoryItemIds.map((itemId) => pdfSplitService.discardDirectorySplits(itemId)))
      if (splitBundle) await pdfSplitService.discard(splitBundle.token)
      throw error
    }
  }

  /**
   * Configures an embedding model on a base that has never had one (BM25-only), then
   * backfills embeddings for its existing items in place — no restore-into-a-new-base
   * needed, since a BM25-only base has no vectors to invalidate. `knowledgeBaseService.
   * update` still rejects switching an already-configured model this way; that case
   * keeps going through `restoreBase` because it does invalidate existing vectors.
   *
   * Runs the same admission checks `reindexItems` would run, but before committing the
   * model — a base whose backfill is doomed (missing source, subtree still running, ...)
   * must never end up with a model set and no vectors to back it, since there is nothing
   * to roll back to once it is committed.
   */
  async enableEmbeddingModel(baseId: string, patch: UpdateKnowledgeBaseDto): Promise<KnowledgeBase> {
    const rootItems = knowledgeItemService.getRootItemsByBaseId(baseId).filter((item) => item.status !== 'deleting')
    const reindexItemIds = rootItems.flatMap((item) =>
      item.type === 'directory' && item.data.pdfSplitSource
        ? knowledgeItemService
            .getSubtreeItems(baseId, [item.id])
            .filter((child) => child.type === 'file' && child.data.pdfPart)
            .map((child) => child.id)
        : [item.id]
    )

    if (reindexItemIds.length > 0) {
      const base = assertBaseCanRunRuntimeOperation(baseId, 'enableEmbeddingModel')
      await this.assertSubtreesCanReindex(baseId, reindexItemIds)
      const rootsRequiringPreflight = rootItems.filter((item) => item.type !== 'directory' || !item.data.pdfSplitSource)
      if (base.fileProcessorId && rootsRequiringPreflight.length > 0) {
        const confirmation = await pdfSplitService.preflightReindex({
          baseId,
          processorId: FileProcessorIdSchema.parse(base.fileProcessorId),
          rootItems: rootsRequiringPreflight
        })
        if (confirmation) {
          await pdfSplitService.discard(confirmation.token)
          throw DataApiErrorFactory.invalidOperation(
            'enableEmbeddingModel',
            'Large PDF sources must be split from the data source list before enabling an embedding model'
          )
        }
      }
    }

    const updatedBase = knowledgeBaseService.update(baseId, patch, { allowEmbeddingModelBackfill: true })

    if (reindexItemIds.length > 0) {
      await this.reindexItems(baseId, reindexItemIds, undefined, true)
    }

    return updatedBase
  }

  async discardSplitConfirmation(token: string): Promise<void> {
    await pdfSplitService.discard(token)
  }

  async scheduleItem(
    baseId: KnowledgeBaseId,
    itemId: KnowledgeItemId,
    parentJobId: string | null = null,
    options: { forceFileProcessing?: boolean } = {}
  ): Promise<void> {
    const base = knowledgeBaseService.getById(baseId)
    const item = knowledgeItemService.getById(itemId)
    if (item.baseId !== baseId) {
      throw new Error(`Knowledge item '${itemId}' does not belong to base '${baseId}'`)
    }
    if (item.status === 'deleting') {
      return
    }

    const plan = planKnowledgeItemSource(base, item, options)
    if (plan.kind === 'invalid') {
      knowledgeItemService.updateStatus(itemId, 'failed', { error: plan.reason })
      return
    }

    const jobManager = application.get('JobManager')
    if (plan.kind === 'prepare-root') {
      jobManager.enqueue(
        'knowledge.prepare-root',
        { baseId, itemId },
        {
          idempotencyKey: knowledgePrepareIdempotencyKey(baseId, itemId),
          queue: knowledgeQueueName(baseId),
          parentId: parentJobId ?? undefined
        }
      )
      return
    }

    if (plan.kind === 'needsFileProcessing') {
      if (item.type !== 'file') {
        throw new Error(`File processing source plan produced for non-file item: ${item.id}`)
      }
      const processorId = FileProcessorIdSchema.parse(base.fileProcessorId)
      const fileProcessing = application.get('FileProcessingService')
      const sourcePath = getKnowledgeBaseFilePath(baseId, item.data.relativePath)
      const processedRelativePath = getProcessedMarkdownRelativePath(item.data.relativePath)
      if (item.data.indexedRelativePath !== processedRelativePath) {
        this.assertKnowledgeRelativePathNotReserved(baseId, base.fileProcessorId, item.id, processedRelativePath)
        await assertKnowledgeFileTargetAvailable(baseId, processedRelativePath)
      }
      const processedPath = getKnowledgeBaseFilePath(baseId, processedRelativePath)
      const fileProcessingJob = await fileProcessing.startJob(
        {
          feature: 'document_to_markdown',
          file: { kind: 'path', path: sourcePath },
          output: { kind: 'path', path: processedPath },
          context: { dataId: item.id },
          processorId
        },
        {
          parentId: parentJobId ?? undefined
        }
      )
      try {
        await this.scheduleFileProcessingCheck(baseId, itemId, fileProcessingJob.id, {
          pollRound: 0,
          firstScheduledAt: Date.now(),
          // Use the file-processing job as workflow parent when this is a direct add flow,
          // so retries keep a stable index idempotency key across poll rounds.
          parentJobId: parentJobId ?? fileProcessingJob.id,
          processedRelativePath
        })
      } catch (error) {
        try {
          await cancelJobOrThrow(fileProcessingJob.id, 'knowledge-file-processing-check-enqueue-failed')
        } catch (cancelError) {
          logger.warn('Failed to cancel file-processing job after check enqueue failure', {
            fileProcessingJobId: fileProcessingJob.id,
            cancelError: cancelError instanceof Error ? cancelError.message : String(cancelError)
          })
        }
        throw error
      }
      return
    }

    await this.scheduleIndexing(baseId, itemId, parentJobId)
  }

  async scheduleFileProcessingCheck(
    baseId: KnowledgeBaseId,
    itemId: KnowledgeItemId,
    fileProcessingJobId: string,
    options: {
      pollRound: number
      firstScheduledAt: number
      parentJobId: string | null
      processedRelativePath: string
      delayMs?: number
    }
  ): Promise<void> {
    const { pollRound, firstScheduledAt, parentJobId, processedRelativePath } = options
    const delayMs =
      options.delayMs ??
      FILE_PROCESSING_PENDING_CHECK_DELAYS_MS[Math.min(pollRound, FILE_PROCESSING_PENDING_CHECK_DELAYS_MS.length - 1)]
    const jobManager = application.get('JobManager')
    jobManager.enqueue(
      'knowledge.check-file-processing-result',
      {
        baseId,
        itemId,
        fileProcessingJobId,
        pollRound,
        firstScheduledAt,
        processedRelativePath
      },
      {
        idempotencyKey: knowledgeFileProcessingCheckIdempotencyKey(baseId, itemId, fileProcessingJobId, pollRound),
        queue: knowledgeQueueName(baseId),
        parentId: parentJobId ?? undefined,
        scheduledAt: Date.now() + delayMs
      }
    )
  }

  /**
   * Enqueue the index-documents job for an item. The single point that builds
   * this job's idempotency key, queue, and parent id — shared by `scheduleItem`
   * and the file-processing check handler so the enqueue stays identical.
   */
  async scheduleIndexing(
    baseId: KnowledgeBaseId,
    itemId: KnowledgeItemId,
    parentJobId: string | null = null
  ): Promise<void> {
    const jobManager = application.get('JobManager')
    jobManager.enqueue(
      'knowledge.index-documents',
      { baseId, itemId },
      {
        idempotencyKey: knowledgeIndexIdempotencyKey(baseId, itemId, parentJobId),
        queue: knowledgeQueueName(baseId),
        parentId: parentJobId ?? undefined
      }
    )
  }

  /**
   * Park items stranded mid-indexing by an app quit / restart at `failed`.
   *
   * Indexing handlers declare `recovery: 'abandon'`, so an interrupted job is
   * cancelled rather than silently resumed on the next launch — a deliberate
   * quit must not auto-spend the (paid) embedding API. The job side is handled
   * by JobManager's startup recovery; this closes the item side. The common case
   * (handler settled the abort as cancelled) is already flipped to `failed` by
   * the job's onSettled; this is the boot-time safety net for the stragglers
   * onSettled lost the race to write (process exited first) or never ran (hard
   * kill / crash). Marking them `failed` clears the perpetual spinner and makes
   * them reindexable so the user can finish them on demand.
   */
  recoverInterruptedItems(): void {
    try {
      const failedCount = knowledgeItemService.failInterruptedItems(KNOWLEDGE_ITEM_ERROR_INDEXING_INTERRUPTED)
      if (failedCount > 0) {
        logger.info('Recovered interrupted knowledge items', { count: failedCount })
      }
    } catch (error) {
      logger.error('Failed to recover interrupted knowledge items', error as Error)
    }
  }

  async cancelInterruptedFileProcessingJobs(): Promise<void> {
    const jobManager = application.get('JobManager')
    const activeFileProcessingJobs = await jobManager.list({
      status: ['pending', 'delayed', 'running'],
      type: [...FILE_PROCESSING_JOB_TYPES]
    })
    const knowledgeLinkedJobIds = activeFileProcessingJobs
      .filter((job) => {
        if (!job.input || typeof job.input !== 'object') return false
        const context = (job.input as { context?: unknown }).context
        return Boolean(
          context && typeof context === 'object' && typeof (context as { dataId?: unknown }).dataId === 'string'
        )
      })
      .map((job) => job.id)

    await Promise.all(
      knowledgeLinkedJobIds.map(async (jobId) => {
        try {
          await cancelJobOrThrow(jobId, 'knowledge-startup-recovery')
        } catch (error) {
          logger.error('Failed to cancel interrupted knowledge file-processing job', error as Error, { jobId })
        }
      })
    )
    if (knowledgeLinkedJobIds.length > 0) {
      logger.info('Cancelled interrupted knowledge file-processing jobs', { count: knowledgeLinkedJobIds.length })
    }
  }

  recoverDeletingItems(): void {
    let deletingRootGroups: Awaited<ReturnType<typeof knowledgeItemService.getDeletingRootGroups>>
    try {
      deletingRootGroups = knowledgeItemService.getDeletingRootGroups()
    } catch (error) {
      logger.error('Failed to scan deleting knowledge items for recovery', error as Error)
      return
    }

    if (deletingRootGroups.length === 0) {
      return
    }

    const jobManager = application.get('JobManager')
    for (const { baseId, rootItemIds } of deletingRootGroups) {
      for (let i = 0; i < rootItemIds.length; i += DELETE_RECOVERY_ROOT_CHUNK_SIZE) {
        const rootItemIdChunk = rootItemIds.slice(i, i + DELETE_RECOVERY_ROOT_CHUNK_SIZE)
        try {
          jobManager.enqueue(
            'knowledge.delete-subtree',
            { baseId, rootItemIds: rootItemIdChunk },
            {
              idempotencyKey: knowledgeDeleteSubtreeIdempotencyKey(
                toKnowledgeBaseId(baseId),
                toKnowledgeItemIds(rootItemIdChunk)
              ),
              queue: knowledgeQueueName(toKnowledgeBaseId(baseId))
            }
          )
        } catch (error) {
          logger.error('Failed to enqueue recovered knowledge delete cleanup', error as Error, {
            baseId,
            rootItemIds: rootItemIdChunk
          })
        }
      }
    }
  }

  private async assertSubtreesCanReindex(baseId: string, rootItemIds: string[]): Promise<void> {
    // rootItemIds comes from getOutermostSelectedItemIds, which guarantees the roots are mutually
    // non-descendant (disjoint subtrees), so one batched query's union equals the per-root sum.
    const subtreeItems = knowledgeItemService.getSubtreeItems(baseId, rootItemIds, { includeRoots: true })
    const rootIdSet = new Set(rootItemIds)
    const roots = subtreeItems.filter((item) => rootIdSet.has(item.id))

    // Reindex deletes the subtree's vectors before re-reading the source (reindexSubtreeJobHandler),
    // so a root whose source is gone would lose its vectors with nothing to rebuild from — reject up
    // front. Only the root's own source matters: a directory is rescanned from data.source and its
    // children recreated (never read from their raw/ files), a file leaf reads its own raw/ file, and
    // note/url always rebuild from the DB / network. A v1-migrated folder child reindexed on its own
    // is a file root whose raw/ file never existed, so this rejects it too. Distinguish a genuinely
    // missing source (delete-and-re-add) from one we could not verify (transient/permission error,
    // which should retry rather than be destroyed).
    const sourceStates = await Promise.all(roots.map((root) => classifyKnowledgeItemSource(baseId, root)))

    const missingSourceItemIds: string[] = []
    const unverifiableSourceItemIds: string[] = []
    roots.forEach((root, index) => {
      if (sourceStates[index] === 'missing') {
        missingSourceItemIds.push(root.id)
      } else if (sourceStates[index] === 'unverifiable') {
        unverifiableSourceItemIds.push(root.id)
      }
    })

    const blockingStatusCounts = new Map<KnowledgeItemStatus, number>()
    for (const item of subtreeItems) {
      if (REINDEX_ALLOWED_STATUSES.has(item.status)) {
        continue
      }
      blockingStatusCounts.set(item.status, (blockingStatusCounts.get(item.status) ?? 0) + 1)
    }

    if (missingSourceItemIds.length > 0) {
      throw DataApiErrorFactory.validation(
        {
          item: [`Knowledge item source no longer exists on disk for ${missingSourceItemIds.length} item(s)`]
        },
        'Cannot reindex a knowledge item whose source file or folder no longer exists; delete it and add it again to rebuild'
      )
    }

    if (unverifiableSourceItemIds.length > 0) {
      throw DataApiErrorFactory.validation(
        {
          item: [`Could not verify the knowledge item source on disk for ${unverifiableSourceItemIds.length} item(s)`]
        },
        'Could not verify the knowledge item source (it may be temporarily unavailable); please try again'
      )
    }

    if (blockingStatusCounts.size === 0) {
      return
    }

    const statusSummary = [...blockingStatusCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([status, count]) => `${status}=${count}`)
      .join(', ')

    throw DataApiErrorFactory.validation(
      {
        item: [`Knowledge item subtree is still running or being deleted: ${statusSummary}`]
      },
      'Cannot reindex knowledge item until the entire subtree is completed or failed'
    )
  }

  private rollbackAcceptedItems(baseId: string, items: KnowledgeItem[], originalError: unknown): void {
    for (const item of items) {
      try {
        knowledgeItemService.delete(item.id)
      } catch (cleanupError) {
        logger.error(
          'Failed to rollback accepted knowledge item after addItems failure',
          cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)),
          {
            baseId,
            itemId: item.id,
            addError: originalError instanceof Error ? originalError.message : String(originalError)
          }
        )
      }
    }
  }

  private async prepareRuntimeAddItemInput(
    baseId: string,
    fileProcessorId: string | null | undefined,
    input: KnowledgeAddItemInput,
    reservedPaths: Set<string>
  ): Promise<CreateKnowledgeItemDto> {
    if (input.type === 'url') {
      if (!input.data.snapshotPath) {
        return input
      }
      // Restore: copy the captured snapshot markdown into this base under a
      // collision-free name and pin the item to it, so the first index reads the
      // snapshot offline (see ensureSnapshot) instead of re-fetching the page.
      const snapshotName = getKnowledgeSourceRelativePath(input.data.snapshotPath)
      const relativePath = reserveImportedFileRelativePath(snapshotName, false, reservedPaths)
      await copyFileIntoKnowledgeBaseAt(baseId, input.data.snapshotPath, relativePath)
      return {
        groupId: input.groupId,
        type: 'url',
        data: { source: input.data.source, url: input.data.url, relativePath }
      }
    }

    if (input.type !== 'file') {
      return input
    }

    assertSupportedKnowledgeFilePath(input.data.path)
    const fileName = getKnowledgeSourceRelativePath(input.data.path)
    // A restore that carries a processed artifact reserves the artifact slot too, even if
    // the destination base has no processor configured, so the copied `.md` cannot collide.
    const reserveArtifact =
      needsProcessedArtifactReservation(fileProcessorId, fileName) || Boolean(input.data.indexedPath)
    const relativePath = reserveImportedFileRelativePath(fileName, reserveArtifact, reservedPaths)
    await copyFileIntoKnowledgeBaseAt(baseId, input.data.path, relativePath)

    if (input.data.indexedPath) {
      // Copy the already-processed artifact next to the source under the reserved name
      // and pin the item to it, so indexing skips the file processor (see needsFileProcessing).
      const indexedRelativePath = getProcessedMarkdownRelativePath(relativePath)
      await copyFileIntoKnowledgeBaseAt(baseId, input.data.indexedPath, indexedRelativePath)
      return {
        groupId: input.groupId,
        type: 'file',
        data: { source: input.data.source, relativePath, indexedRelativePath }
      }
    }

    return {
      groupId: input.groupId,
      type: 'file',
      data: {
        source: input.data.source,
        relativePath
      }
    }
  }

  private async convertFileToPdfSplit(
    base: KnowledgeBase,
    item: KnowledgeItemOf<'file'>,
    split: StagedPdfSplit
  ): Promise<void> {
    const reservedPaths = this.loadReservedKnowledgeFilePaths(base.id, base.fileProcessorId)
    for (const ownPath of [item.data.relativePath, item.data.indexedRelativePath]) {
      if (ownPath) reservedPaths.delete(ownPath)
    }
    const relativePrefix = reservePdfSplitDirectoryRelativePath(item.data.relativePath, reservedPaths)
    const published = await pdfSplitService.publishStagedSplit(base.id, split, relativePrefix)
    let createdParts: KnowledgeItem[] = []
    try {
      await this.knowledgeLockManager.runExclusive(base.id, async () => {
        await deleteKnowledgeItemVectors(base, [item.id])
        const replaced = knowledgeItemService.replaceWithPdfSplitSubtree(base.id, item.id, {
          data: {
            source: item.data.source,
            relativePath: relativePrefix,
            pdfSplitSource: {
              relativePath: published.sourceRelativePath,
              sourceName: path.basename(item.data.relativePath),
              totalPages: split.pageCount
            }
          },
          parts: toPdfPartData(published.parts)
        })
        createdParts = replaced.parts
        await deleteKnowledgeItemFilesBestEffort(base.id, [item], {
          baseId: base.id,
          itemId: item.id,
          reason: 'pdf-split-conversion'
        })
      })
    } catch (error) {
      await deleteKnowledgeItemFilesBestEffort(
        base.id,
        [{ type: 'directory', data: { source: item.data.source, relativePath: relativePrefix } }],
        { baseId: base.id, itemId: item.id, reason: 'pdf-split-conversion-rollback' }
      )
      throw error
    }

    const scheduledPartIds = new Set<string>()
    try {
      for (const part of createdParts) {
        await this.scheduleItem(toKnowledgeBaseId(base.id), toKnowledgeItemId(part.id))
        scheduledPartIds.add(part.id)
      }
    } catch (error) {
      this.markUnscheduledAcceptedItemsFailed(base.id, createdParts, scheduledPartIds, error)
      throw error
    }
  }

  private loadReservedKnowledgeFilePaths(baseId: string, fileProcessorId: string | null | undefined): Set<string> {
    const items = knowledgeItemService.getItemsByBaseId(baseId)
    return collectKnowledgeReservedRelativePaths(items, { fileProcessorId })
  }

  private assertKnowledgeRelativePathNotReserved(
    baseId: string,
    fileProcessorId: string | null | undefined,
    itemId: string,
    relativePath: string
  ): void {
    const items = knowledgeItemService.getItemsByBaseId(baseId)
    const reserved = collectKnowledgeReservedRelativePaths(items, { fileProcessorId, excludeItemId: itemId })
    if (reserved.has(relativePath)) {
      throw new Error(`Knowledge file already exists: ${relativePath}`)
    }
  }

  private markUnscheduledAcceptedItemsFailed(
    baseId: string,
    items: KnowledgeItem[],
    completedSchedulingItemIds: Set<string>,
    originalError: unknown
  ): void {
    const message = originalError instanceof Error ? originalError.message : String(originalError)
    markUnscheduledKnowledgeItemsFailed({
      baseId,
      items,
      completedItemIds: completedSchedulingItemIds,
      errorMessage: message,
      failedStatusError: `Failed to schedule knowledge item job: ${message}`,
      logger,
      logMessage: 'Failed to mark unscheduled knowledge item after addItems scheduling failure'
    })
  }
}

function reservePdfSplitDirectoryRelativePath(sourcePath: string, reservedPaths: Set<string>): PosixRelativeFilePath {
  const sourceName = path.basename(sourcePath)
  const proposed = path.parse(sourceName).name || 'document'
  const chosen = nextFreeKnowledgeRelativePath(
    proposed,
    (candidate) =>
      ![...reservedPaths].some(
        (reserved) =>
          reserved === candidate || reserved.startsWith(`${candidate}/`) || candidate.startsWith(`${reserved}/`)
      ),
    false
  )
  assertSafeKnowledgeRelativePath(chosen)
  reservedPaths.add(chosen)
  return chosen
}

function toPdfPartData(
  parts: Array<{
    fileName: string
    relativePath: PosixRelativeFilePath
    pageStart: number
    pageEnd: number
  }>
): Array<KnowledgeItemOf<'file'>['data']> {
  return parts.map((part, index) => ({
    source: part.fileName,
    relativePath: part.relativePath,
    pdfPart: {
      partIndex: index + 1,
      pageStart: part.pageStart,
      pageEnd: part.pageEnd
    }
  }))
}

function assertSupportedKnowledgeFilePath(filePath: string): void {
  if (!KNOWLEDGE_SUPPORTED_FILE_EXT_SET.has(getFileExt(filePath).toLowerCase())) {
    throw new Error(`Unsupported knowledge file type: ${filePath}`)
  }
}
