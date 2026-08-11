import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'

import { PDFDocument } from 'pdf-lib'

import type { PdfPageRange, PdfSplitWorkerInput, PdfSplitWorkerMessage, StagedPdfPart } from './types'

if (!parentPort) {
  throw new Error('PDF split worker requires a parent port')
}

const input = workerData as PdfSplitWorkerInput

function postError(code: string, error: unknown): void {
  parentPort?.postMessage({
    type: 'error',
    code,
    message: error instanceof Error ? error.message : String(error)
  } satisfies PdfSplitWorkerMessage)
}

function classifyLoadError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return /encrypted/i.test(message) ? 'encrypted' : 'invalid'
}

async function loadPdf(sourcePath: string): Promise<{
  bytes: Uint8Array
  fingerprint: string
  pdf: PDFDocument
}> {
  const bytes = await fs.readFile(sourcePath)
  const fingerprint = createHash('sha256').update(bytes).digest('hex')
  let pdf: PDFDocument
  try {
    pdf = await PDFDocument.load(bytes, { updateMetadata: false })
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      pdfErrorCode: classifyLoadError(error)
    })
  }
  if (pdf.getPageCount() === 0) {
    throw Object.assign(new Error('PDF contains no pages'), { pdfErrorCode: 'empty' })
  }
  return { bytes, fingerprint, pdf }
}

async function serializeRange(source: PDFDocument, range: PdfPageRange): Promise<Uint8Array> {
  const output = await PDFDocument.create()
  const pageIndexes = Array.from(
    { length: range.pageEnd - range.pageStart + 1 },
    (_, index) => range.pageStart - 1 + index
  )
  const pages = await output.copyPages(source, pageIndexes)
  for (const page of pages) {
    output.addPage(page)
  }
  return await output.save()
}

async function splitRange(
  source: PDFDocument,
  range: PdfPageRange,
  options: { stagingDir: string; maxInputBytes: number; maxParts: number },
  parts: StagedPdfPart[]
): Promise<void> {
  const bytes = await serializeRange(source, range)
  if (bytes.byteLength >= options.maxInputBytes) {
    if (range.pageStart === range.pageEnd) {
      throw Object.assign(new Error(`PDF page ${range.pageStart} is too large for the processor byte limit`), {
        pdfErrorCode: 'single_page_too_large'
      })
    }
    const midpoint = Math.floor((range.pageStart + range.pageEnd) / 2)
    await splitRange(source, { pageStart: range.pageStart, pageEnd: midpoint }, options, parts)
    await splitRange(source, { pageStart: midpoint + 1, pageEnd: range.pageEnd }, options, parts)
    return
  }

  if (parts.length >= options.maxParts) {
    throw Object.assign(new Error(`PDF requires more than ${options.maxParts} parts`), {
      pdfErrorCode: 'too_many_parts'
    })
  }

  const fileName = `part-${range.pageStart}-${range.pageEnd}.pdf`
  const outputPath = path.join(options.stagingDir, fileName)
  await fs.writeFile(outputPath, bytes)
  parts.push({ ...range, bytes: bytes.byteLength, path: outputPath })
}

async function run(): Promise<void> {
  let loaded: Awaited<ReturnType<typeof loadPdf>>
  try {
    loaded = await loadPdf(input.sourcePath)
  } catch (error) {
    postError((error as { pdfErrorCode?: string }).pdfErrorCode ?? 'read_failed', error)
    return
  }

  if (input.operation === 'inspect') {
    parentPort?.postMessage({
      type: 'inspected',
      inspection: { fingerprint: loaded.fingerprint, pageCount: loaded.pdf.getPageCount() }
    } satisfies PdfSplitWorkerMessage)
    return
  }

  if (loaded.fingerprint !== input.expectedFingerprint) {
    postError('source_changed', new Error('PDF changed while it was being prepared'))
    return
  }

  try {
    const parts: StagedPdfPart[] = []
    for (const range of input.initialRanges) {
      await splitRange(
        loaded.pdf,
        range,
        {
          stagingDir: input.stagingDir,
          maxInputBytes: input.maxInputBytes,
          maxParts: input.maxParts
        },
        parts
      )
    }
    parentPort?.postMessage({ type: 'split', parts } satisfies PdfSplitWorkerMessage)
  } catch (error) {
    postError((error as { pdfErrorCode?: string }).pdfErrorCode ?? 'split_failed', error)
  }
}

void run()
