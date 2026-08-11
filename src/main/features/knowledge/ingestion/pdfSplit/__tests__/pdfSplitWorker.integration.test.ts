import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { PDFDocument, StandardFonts } from 'pdf-lib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../pdfSplitWorker?nodeWorker', async () => {
  const { Worker } = await import('node:worker_threads')
  return {
    default: (options: ConstructorParameters<typeof Worker>[1]) =>
      new Worker(`${process.cwd()}/src/main/features/knowledge/ingestion/pdfSplit/pdfSplitWorker.ts`, options)
  }
})

import { runPdfSplitWorker } from '../pdfSplitWorkerClient'

describe('PDF split worker integration', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-pdf-worker-'))
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('inspects valid PDFs and rejects empty or damaged PDFs', async () => {
    const validPath = path.join(tempDir, 'valid.pdf')
    await createPdf(validPath, 2)
    const inspected = await runPdfSplitWorker({ operation: 'inspect', sourcePath: validPath })
    expect(inspected).toMatchObject({ type: 'inspected', inspection: { pageCount: 2 } })

    const emptyPath = path.join(tempDir, 'empty.pdf')
    const empty = await PDFDocument.create()
    await fs.writeFile(emptyPath, await empty.save({ addDefaultPage: false }))
    await expect(runPdfSplitWorker({ operation: 'inspect', sourcePath: emptyPath })).resolves.toMatchObject({
      type: 'error',
      code: 'empty'
    })

    const damagedPath = path.join(tempDir, 'damaged.pdf')
    await fs.writeFile(damagedPath, 'not a pdf')
    await expect(runPdfSplitWorker({ operation: 'inspect', sourcePath: damagedPath })).resolves.toMatchObject({
      type: 'error',
      code: 'invalid'
    })
  })

  it('recursively bisects a byte-oversized page range and writes ordered parts', async () => {
    const sourcePath = path.join(tempDir, 'source.pdf')
    await createPdf(sourcePath, 4)
    const inspected = await runPdfSplitWorker({ operation: 'inspect', sourcePath })
    if (inspected.type !== 'inspected') throw new Error('inspection failed')

    const onePageDir = path.join(tempDir, 'one-page')
    await fs.mkdir(onePageDir)
    const onePage = await runPdfSplitWorker({
      operation: 'split',
      sourcePath,
      stagingDir: onePageDir,
      expectedFingerprint: inspected.inspection.fingerprint,
      initialRanges: [{ pageStart: 1, pageEnd: 1 }],
      maxInputBytes: 10 * 1024 ** 2,
      maxParts: 200
    })
    if (onePage.type !== 'split') throw new Error('one-page split failed')
    const maxInputBytes = onePage.parts[0].bytes + 100

    const outputDir = path.join(tempDir, 'parts')
    await fs.mkdir(outputDir)
    const split = await runPdfSplitWorker({
      operation: 'split',
      sourcePath,
      stagingDir: outputDir,
      expectedFingerprint: inspected.inspection.fingerprint,
      initialRanges: [{ pageStart: 1, pageEnd: 4 }],
      maxInputBytes,
      maxParts: 200
    })

    expect(split.type).toBe('split')
    if (split.type !== 'split') return
    expect(split.parts.length).toBeGreaterThan(1)
    expect(split.parts[0].pageStart).toBe(1)
    expect(split.parts.at(-1)?.pageEnd).toBe(4)
    expect(split.parts.every((part) => part.bytes < maxInputBytes)).toBe(true)
    await expect(Promise.all(split.parts.map((part) => fs.stat(part.path)))).resolves.toHaveLength(split.parts.length)
  })

  it('returns an actionable error when one page alone exceeds the byte limit', async () => {
    const sourcePath = path.join(tempDir, 'source.pdf')
    await createPdf(sourcePath, 1)
    const inspected = await runPdfSplitWorker({ operation: 'inspect', sourcePath })
    if (inspected.type !== 'inspected') throw new Error('inspection failed')
    const stagingDir = path.join(tempDir, 'parts')
    await fs.mkdir(stagingDir)

    await expect(
      runPdfSplitWorker({
        operation: 'split',
        sourcePath,
        stagingDir,
        expectedFingerprint: inspected.inspection.fingerprint,
        initialRanges: [{ pageStart: 1, pageEnd: 1 }],
        maxInputBytes: 1,
        maxParts: 200
      })
    ).resolves.toMatchObject({ type: 'error', code: 'single_page_too_large' })
  })
})

async function createPdf(filePath: string, pageCount: number): Promise<void> {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  for (let index = 0; index < pageCount; index += 1) {
    const page = document.addPage([612, 792])
    page.drawText(`Page ${index + 1} ${'content '.repeat(100)}`, { x: 40, y: 740, size: 10, font })
  }
  await fs.writeFile(filePath, await document.save())
}
