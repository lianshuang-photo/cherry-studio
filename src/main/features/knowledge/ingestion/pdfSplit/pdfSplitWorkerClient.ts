import type { Worker } from 'node:worker_threads'

// oxlint-disable-next-line import/default -- Electron Vite exposes ?nodeWorker imports as default worker factories.
import createPdfSplitWorker from './pdfSplitWorker?nodeWorker'
import type { PdfSplitWorkerInput, PdfSplitWorkerMessage } from './types'

function getAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('PDF split aborted', 'AbortError')
}

export function runPdfSplitWorker(input: PdfSplitWorkerInput, signal?: AbortSignal): Promise<PdfSplitWorkerMessage> {
  if (signal?.aborted) return Promise.reject(getAbortReason(signal))
  return new Promise((resolve, reject) => {
    const worker = createPdfSplitWorker({ workerData: input })
    let settled = false
    const cleanup = () => {
      signal?.removeEventListener('abort', handleAbort)
      worker.removeListener('message', handleMessage)
      worker.removeListener('error', handleError)
      worker.removeListener('exit', handleExit)
    }
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      void terminateWorker(worker).then(callback)
    }
    const handleMessage = (message: PdfSplitWorkerMessage) => finish(() => resolve(message))
    const handleError = (error: Error) => finish(() => reject(error))
    const handleExit = (code: number) =>
      finish(() => reject(new Error(`PDF split worker exited before responding (code ${code})`)))
    const handleAbort = () => finish(() => reject(signal ? getAbortReason(signal) : new Error('PDF split aborted')))

    worker.unref()
    worker.once('message', handleMessage)
    worker.once('error', handleError)
    worker.once('exit', handleExit)
    signal?.addEventListener('abort', handleAbort, { once: true })
    if (signal?.aborted) handleAbort()
  })
}

async function terminateWorker(worker: Worker): Promise<void> {
  try {
    await worker.terminate()
  } catch {
    // The worker may already have exited after posting its result.
  }
}
