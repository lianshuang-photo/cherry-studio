import { describe, expect, it } from 'vitest'

import { createInitialPdfPageRanges, formatPdfPartFileName } from '../pdfSplitPlanning'
import type { PdfSplitLimits } from '../types'

function limits(overrides: Partial<PdfSplitLimits>): PdfSplitLimits {
  return {
    processorId: 'doc2x',
    maxInputBytes: 1024 ** 3,
    fingerprint: 'limits',
    ...overrides
  }
}

describe('PDF split page planning', () => {
  it.each([
    ['Doc2x 30 pages', 30, limits({ targetPagesPerPart: 30 }), 1],
    ['Doc2x 31 pages', 31, limits({ targetPagesPerPart: 30 }), 2],
    ['MinerU 200 pages', 200, limits({ maxPagesPerPart: 200 }), 1],
    ['MinerU 201 pages', 201, limits({ maxPagesPerPart: 200 }), 2],
    ['Mistral 1000 pages', 1000, limits({ maxPagesPerPart: 1000 }), 1],
    ['Mistral 1001 pages', 1001, limits({ maxPagesPerPart: 1000 }), 2]
  ])('%s creates the expected number of ranges', (_name, pageCount, processorLimits, expectedParts) => {
    expect(createInitialPdfPageRanges(pageCount, processorLimits)).toHaveLength(expectedParts)
  })

  it('creates 142 ordered ranges for the diagnosed 4246-page PDF', () => {
    const ranges = createInitialPdfPageRanges(4246, limits({ targetPagesPerPart: 30 }))

    expect(ranges).toHaveLength(142)
    expect(ranges[0]).toEqual({ pageStart: 1, pageEnd: 30 })
    expect(ranges.at(-1)).toEqual({ pageStart: 4231, pageEnd: 4246 })
    expect(ranges.every((range, index) => index === 0 || range.pageStart === ranges[index - 1].pageEnd + 1)).toBe(true)
  })

  it('makes page-range names stable and zero-padded', () => {
    expect(formatPdfPartFileName('example.pdf', 1, 30, 4246)).toBe('example_0001-0030.pdf')
    expect(formatPdfPartFileName('example.pdf', 4231, 4246, 4246)).toBe('example_4231-4246.pdf')
  })

  it('exposes a 201-part plan so the service can reject it before publication', () => {
    expect(createInitialPdfPageRanges(201, limits({ targetPagesPerPart: 1 }))).toHaveLength(201)
  })
})
