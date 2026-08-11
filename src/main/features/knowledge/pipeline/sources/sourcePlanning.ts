import { getFileExt } from '@main/utils/legacyFile'
import type { KnowledgeBase } from '@shared/data/types/knowledge'
import type { KnowledgeItem } from '@shared/data/types/knowledge'
import { knowledgeFileProcessingExts } from '@shared/utils/file'

import { isContainerKnowledgeItem, isIndexableKnowledgeItem } from '../../items'

const KNOWLEDGE_FILE_PROCESSING_EXT_SET = new Set<string>(knowledgeFileProcessingExts)

export type KnowledgeSourcePlan =
  | { kind: 'prepare-root' }
  | { kind: 'index-documents' }
  | { kind: 'needsFileProcessing' }
  | { kind: 'invalid'; reason: string }

export function planKnowledgeItemSource(
  base: KnowledgeBase,
  item: KnowledgeItem,
  options: { forceFileProcessing?: boolean } = {}
): KnowledgeSourcePlan {
  if (isContainerKnowledgeItem(item)) {
    return { kind: 'prepare-root' }
  }

  if (needsFileProcessing(base, item, options.forceFileProcessing === true)) {
    return { kind: 'needsFileProcessing' }
  }

  if (isIndexableKnowledgeItem(item)) {
    return { kind: 'index-documents' }
  }

  return { kind: 'invalid', reason: 'Unsupported knowledge item type' }
}

function needsFileProcessing(base: KnowledgeBase, item: KnowledgeItem, forceFileProcessing: boolean): boolean {
  if (item.type !== 'file' || !base.fileProcessorId) {
    return false
  }

  // A restored file indexes straight from its copied artifact. Explicit user
  // reindex bypasses this shortcut so the processor produces a fresh artifact.
  if (item.data.indexedRelativePath && !forceFileProcessing) {
    return false
  }

  const ext = getFileExt(item.data.relativePath).toLowerCase()
  return KNOWLEDGE_FILE_PROCESSING_EXT_SET.has(ext)
}
