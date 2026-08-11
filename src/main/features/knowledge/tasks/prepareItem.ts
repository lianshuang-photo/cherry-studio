import { knowledgeItemService } from '@data/services/KnowledgeItemService'
import { loggerService } from '@logger'
import {
  type CreateKnowledgeItemDto,
  type KnowledgeItem,
  type KnowledgeItemOf,
  type KnowledgeItemType
} from '@shared/data/types/knowledge'

import { pdfSplitService } from '../ingestion/pdfSplit/PdfSplitService'
import { type IndexableKnowledgeItem, isIndexableKnowledgeItem } from '../items'
import { collectKnowledgeReservedRelativePaths } from '../pathStorage'
import {
  chooseDirectoryPathPrefix,
  type DirectoryPdfSplitPublisher,
  expandDirectoryOwnerToTree,
  type ExpandedDirectoryNode
} from '../pipeline/sources/directory'

const logger = loggerService.withContext('KnowledgePrepare')
const EMPTY_DIRECTORY_ERROR = 'Directory contains no indexable files'

export interface PrepareKnowledgeItemOptions {
  baseId: string
  item: KnowledgeItem
  signal: AbortSignal
  onDirectoryCopyProgress: (percent: number) => void
}

export async function prepareKnowledgeItem({
  baseId,
  item,
  signal,
  onDirectoryCopyProgress
}: PrepareKnowledgeItemOptions): Promise<IndexableKnowledgeItem[]> {
  signal.throwIfAborted()

  if (isIndexableKnowledgeItem(item)) {
    return [item]
  }

  return await prepareDirectoryForRuntime(baseId, item, signal, onDirectoryCopyProgress)
}

async function prepareDirectoryForRuntime(
  baseId: string,
  item: KnowledgeItemOf<'directory'>,
  signal: AbortSignal,
  onDirectoryCopyProgress: (percent: number) => void
): Promise<IndexableKnowledgeItem[]> {
  if (item.data.pdfSplitSource) {
    return await prepareSyntheticPdfForRuntime(baseId, item, signal)
  }

  // Exclude this container itself: on reindex it already owns its `relativePath`
  // prefix, and counting it as reserved would self-collide it to `_1` every time.
  const reservedTopLevelNames = collectReservedTopLevelNames(baseId, item.id)
  const pathPrefix = chooseDirectoryPathPrefix(item, reservedTopLevelNames)

  // Pin the deduped `raw/` prefix onto the container BEFORE any byte is copied. Expansion
  // durably writes files under `raw/<pathPrefix>/...`; if a crash/kill/abort lands mid-copy,
  // the pinned `relativePath` lets the next attempt's `deletePreviousLeafExpansion` reclaim
  // the whole shell (orphan bytes are always a subset of `raw/<pathPrefix>`). The UI also
  // shows the on-disk name (e.g. `docs_2`) and delete removes the shell by it.
  knowledgeItemService.updateDirectoryRelativePath(item.id, pathPrefix)

  await pdfSplitService.assertDirectoryBundleCurrent(item.id, signal)
  const stagedSplits = pdfSplitService.getDirectorySplits(item.id)
  const manifest = pdfSplitService.getDirectoryManifest(item.id)
  const stagedSplitBySource = new Map(stagedSplits.map((split) => [split.sourcePath, split]))
  const pdfSplitPublisher: DirectoryPdfSplitPublisher | undefined =
    stagedSplits.length > 0
      ? {
          hasSplit: (sourcePath) => stagedSplitBySource.has(sourcePath),
          publish: async (sourcePath, relativePrefix, publishSignal) => {
            const split = stagedSplitBySource.get(sourcePath)
            if (!split) throw new Error(`Missing staged PDF split for ${sourcePath}`)
            const published = await pdfSplitService.publishStagedSplit(baseId, split, relativePrefix, {
              signal: publishSignal,
              overwrite: true
            })
            return {
              type: 'directory',
              data: {
                source: split.sourcePath,
                relativePath: relativePrefix,
                pdfSplitSource: {
                  relativePath: published.sourceRelativePath,
                  sourceName: pathBasename(split.sourcePath),
                  totalPages: split.pageCount
                }
              },
              children: published.parts.map((part, index) => ({
                type: 'file' as const,
                data: {
                  source: part.fileName,
                  relativePath: part.relativePath,
                  pdfPart: {
                    partIndex: index + 1,
                    pageStart: part.pageStart,
                    pageEnd: part.pageEnd
                  }
                }
              }))
            }
          }
        }
      : undefined
  const children = await expandDirectoryOwnerToTree(
    item,
    baseId,
    pathPrefix,
    signal,
    onDirectoryCopyProgress,
    pdfSplitPublisher,
    manifest
  )
  signal.throwIfAborted()

  if (children.length === 0) {
    logger.warn('Directory expansion produced no indexable files', {
      baseId,
      itemId: item.id,
      source: item.data.source
    })
    knowledgeItemService.updateStatus(item.id, 'failed', { error: EMPTY_DIRECTORY_ERROR })
    return []
  }

  return await createDirectoryChildren(baseId, item.id, children, signal)
}

async function prepareSyntheticPdfForRuntime(
  baseId: string,
  item: KnowledgeItemOf<'directory'>,
  signal: AbortSignal
): Promise<IndexableKnowledgeItem[]> {
  const [split] = pdfSplitService.getDirectorySplits(item.id)
  if (!split) {
    throw new Error('PDF split confirmation is required before rebuilding this document')
  }
  const source = item.data.pdfSplitSource
  if (!source || !item.data.relativePath) {
    throw new Error(`Synthetic PDF directory '${item.id}' is missing its private source metadata`)
  }
  const published = await pdfSplitService.publishStagedSplit(baseId, split, item.data.relativePath, {
    signal,
    sourceAlreadyStoredRelativePath: source.relativePath,
    overwrite: true
  })
  const replaced = knowledgeItemService.replaceWithPdfSplitSubtree(baseId, item.id, {
    data: {
      ...item.data,
      pdfSplitSource: { ...source, totalPages: split.pageCount }
    },
    parts: published.parts.map((part, index) => ({
      source: part.fileName,
      relativePath: part.relativePath,
      pdfPart: {
        partIndex: index + 1,
        pageStart: part.pageStart,
        pageEnd: part.pageEnd
      }
    }))
  })
  return replaced.parts as IndexableKnowledgeItem[]
}

/**
 * Top-level `raw/` segment of every name already occupied in the base — the set a
 * directory expansion must avoid when claiming its own basename. Each reserved
 * relativePath contributes its first segment: a bare file (`report.pdf`) or another
 * directory's namespace (`docs/sub/a.pdf` → `docs`). Runs inside the base mutation
 * lock, so the read-then-dedupe-then-write is free of concurrent expansions.
 */
function collectReservedTopLevelNames(baseId: string, excludeItemId?: string): Set<string> {
  const items = knowledgeItemService.getItemsByBaseId(baseId)
  const names = new Set<string>()
  for (const relativePath of collectKnowledgeReservedRelativePaths(items, { excludeItemId })) {
    const topSegment = relativePath.split('/')[0]
    if (topSegment) {
      names.add(topSegment)
    }
  }
  return names
}

async function createDirectoryChildren(
  baseId: string,
  parentId: string,
  children: ExpandedDirectoryNode[],
  signal: AbortSignal
): Promise<IndexableKnowledgeItem[]> {
  const leafItems: IndexableKnowledgeItem[] = []

  for (const child of children) {
    signal.throwIfAborted()

    if (child.type === 'file') {
      const createdFile = await createRuntimeItem(
        baseId,
        {
          groupId: parentId,
          type: 'file',
          data: child.data
        },
        signal
      )
      leafItems.push(createdFile)
      continue
    }

    if (child.data.pdfSplitSource) {
      const partChildren = child.children.filter(
        (part): part is Extract<ExpandedDirectoryNode, { type: 'file' }> => part.type === 'file'
      )
      if (partChildren.length !== child.children.length) {
        throw new Error('Synthetic PDF directory may contain only file parts')
      }
      const created = knowledgeItemService.createPdfSplitSubtree(baseId, {
        groupId: parentId,
        data: child.data,
        parts: partChildren.map((part) => part.data)
      })
      leafItems.push(...(created.parts as IndexableKnowledgeItem[]))
      continue
    }

    const createdDirectory = await createRuntimeItem(
      baseId,
      {
        groupId: parentId,
        type: 'directory',
        data: child.data
      },
      signal
    )
    const childLeafItems = await createDirectoryChildren(baseId, createdDirectory.id, child.children, signal)
    knowledgeItemService.updateStatus(createdDirectory.id, 'processing')
    leafItems.push(...childLeafItems)
  }

  return leafItems
}

function pathBasename(value: string): string {
  return (
    value
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() || value
  )
}

async function createRuntimeItem<T extends KnowledgeItemType>(
  baseId: string,
  item: Extract<CreateKnowledgeItemDto, { type: T }>,
  signal: AbortSignal
): Promise<KnowledgeItemOf<T>> {
  signal.throwIfAborted()
  const createdItem = knowledgeItemService.createActive(baseId, item)
  signal.throwIfAborted()

  return createdItem as KnowledgeItemOf<T>
}
