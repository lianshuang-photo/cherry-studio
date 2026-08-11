import type { FileProcessorId } from '@shared/data/preference/preferenceTypes'
import type {
  KnowledgeAddConflictStrategy,
  KnowledgeAddItemInput,
  KnowledgeItem,
  KnowledgePdfSplitConfirmation
} from '@shared/data/types/knowledge'
import type { PosixRelativeFilePath } from '@shared/utils/file'

import type { DirectorySourceManifest } from '../../pipeline/sources/directory'

export interface PdfPageRange {
  pageStart: number
  pageEnd: number
}

export interface PdfSplitLimits {
  processorId: FileProcessorId
  maxInputBytes: number
  maxPagesPerPart?: number
  targetPagesPerPart?: number
  fingerprint: string
}

export interface PdfInspection {
  fingerprint: string
  pageCount: number
}

export interface StagedPdfPart extends PdfPageRange {
  bytes: number
  path: string
}

export interface StagedPdfSplit {
  /** External source identity used to match a directory manifest and detect pre-confirm edits. */
  sourcePath: string
  /** Immutable copy owned by the confirmation token and used for splitting/publishing. */
  stagedSourcePath: string
  sourceName: string
  sourceBytes: number
  sourceFingerprint: string
  pageCount: number
  stagingDir: string
  parts: StagedPdfPart[]
  owner:
    | { kind: 'add-file'; inputIndex: number }
    | { kind: 'add-directory'; inputIndex: number }
    | { kind: 'reindex-file'; itemId: string }
    | { kind: 'reindex-directory'; itemId: string }
}

export interface PdfDirectoryPlan {
  sourcePath: string
  manifest: DirectorySourceManifest
  pdfFingerprints: Array<{ sourcePath: string; fingerprint: string }>
  owner: { kind: 'add-directory'; inputIndex: number } | { kind: 'reindex-directory'; itemId: string }
}

export interface PublishedPdfSplit {
  sourceRelativePath: PosixRelativeFilePath
  parts: Array<StagedPdfPart & { fileName: string; relativePath: PosixRelativeFilePath }>
}

export interface PdfSplitBundle {
  token: string
  operation: 'add' | 'reindex' | 'restore'
  baseId: string
  requestFingerprint: string
  limitsFingerprint: string
  expiresAt: number
  confirmation: KnowledgePdfSplitConfirmation
  splits: StagedPdfSplit[]
  directoryPlans: PdfDirectoryPlan[]
}

export interface PdfSplitRestoreRequest {
  sourceBaseId: string
  processorId: FileProcessorId
  inputs: KnowledgeAddItemInput[]
}

export interface PdfSplitAddRequest {
  baseId: string
  processorId: FileProcessorId
  inputs: KnowledgeAddItemInput[]
  conflictStrategy: KnowledgeAddConflictStrategy
}

export interface PdfSplitReindexRequest {
  baseId: string
  processorId: FileProcessorId
  rootItems: KnowledgeItem[]
}

export type PdfSplitWorkerInput =
  | { operation: 'inspect'; sourcePath: string }
  | {
      operation: 'split'
      sourcePath: string
      stagingDir: string
      expectedFingerprint: string
      initialRanges: PdfPageRange[]
      maxInputBytes: number
      maxParts: number
    }

export type PdfSplitWorkerMessage =
  | { type: 'inspected'; inspection: PdfInspection }
  | { type: 'split'; parts: StagedPdfPart[] }
  | { type: 'error'; code: string; message: string }
