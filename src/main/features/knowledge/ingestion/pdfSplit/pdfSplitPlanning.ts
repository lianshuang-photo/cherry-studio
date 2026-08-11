import path from 'node:path'

import type { PdfPageRange, PdfSplitLimits } from './types'

export function createInitialPdfPageRanges(pageCount: number, limits: PdfSplitLimits): PdfPageRange[] {
  if (!Number.isInteger(pageCount) || pageCount <= 0) {
    throw new Error('PDF must contain at least one page')
  }

  const pagesPerPart = limits.targetPagesPerPart ?? limits.maxPagesPerPart ?? pageCount
  const ranges: PdfPageRange[] = []
  for (let pageStart = 1; pageStart <= pageCount; pageStart += pagesPerPart) {
    ranges.push({
      pageStart,
      pageEnd: Math.min(pageStart + pagesPerPart - 1, pageCount)
    })
  }
  return ranges
}

export function pdfNeedsSplitting(pageCount: number, sourceBytes: number, limits: PdfSplitLimits): boolean {
  const pageLimit = limits.targetPagesPerPart ?? limits.maxPagesPerPart
  return (pageLimit !== undefined && pageCount > pageLimit) || sourceBytes >= limits.maxInputBytes
}

export function formatPdfPartFileName(
  sourceName: string,
  pageStart: number,
  pageEnd: number,
  totalPages: number
): string {
  const width = Math.max(4, String(totalPages).length)
  const stem = path.parse(sourceName).name
  return `${stem}_${String(pageStart).padStart(width, '0')}-${String(pageEnd).padStart(width, '0')}.pdf`
}
