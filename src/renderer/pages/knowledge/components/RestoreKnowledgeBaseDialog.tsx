import { Dialog, DialogContent, DialogDescription, FieldError, Input, Label } from '@cherrystudio/ui'
import { loggerService } from '@logger'
import { useCloseBeforeAction } from '@renderer/hooks/useCloseBeforeAction'
import type { RestoreKnowledgeBaseInput } from '@renderer/hooks/useKnowledgeBase'
import { ipcApi } from '@renderer/ipc'
import { toast } from '@renderer/services/toast'
import { formatErrorMessageWithPrefix } from '@renderer/utils/error'
import type { KnowledgeBase, RestoreKnowledgeBaseResult } from '@shared/data/types/knowledge'
import type { FormEvent } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useEmbeddingDimensions } from '../hooks/useEmbeddingDimensions'
import { getKnowledgeBaseFailureReason } from '../utils/error'
import CreateKnowledgeBaseDialog from './CreateKnowledgeBaseDialog'
import { KnowledgeDialogBody, KnowledgeDialogField } from './KnowledgeDialogLayout'
import { KnowledgeEmbeddingModelSelect } from './KnowledgeEmbeddingModelSelect'
import PdfSplitConfirmationDialog, { type PdfSplitConfirmationDialogState } from './PdfSplitConfirmationDialog'

const logger = loggerService.withContext('RestoreKnowledgeBaseDialog')

interface RestoreKnowledgeBaseDialogProps {
  open: boolean
  base: KnowledgeBase
  initialEmbeddingModelId?: string | null
  isRestoring: boolean
  restoreBase: (input: RestoreKnowledgeBaseInput) => Promise<RestoreKnowledgeBaseResult>
  onOpenChange: (open: boolean) => void
  onRestored: (base: KnowledgeBase) => void
}

interface RestoreKnowledgeBaseFormValues {
  name: string
  embeddingModelId: string | null
}

const createInitialValues = (
  name: string,
  embeddingModelId: string | null | undefined
): RestoreKnowledgeBaseFormValues => ({
  name,
  embeddingModelId: embeddingModelId ?? null
})

const RestoreKnowledgeBaseDialog = ({
  open,
  base,
  initialEmbeddingModelId,
  isRestoring,
  restoreBase,
  onOpenChange,
  onRestored
}: RestoreKnowledgeBaseDialogProps) => {
  const { t } = useTranslation()
  const defaultName = t('knowledge.restore.default_name', { name: base.name })
  const failureReason = base.status === 'failed' ? getKnowledgeBaseFailureReason(base, t) : null
  const [values, setValues] = useState<RestoreKnowledgeBaseFormValues>(() =>
    createInitialValues(defaultName, initialEmbeddingModelId)
  )
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [pendingRestoreInput, setPendingRestoreInput] = useState<RestoreKnowledgeBaseInput | null>(null)
  const [pdfSplitState, setPdfSplitState] = useState<PdfSplitConfirmationDialogState>({ status: 'closed' })
  const [pdfSplitError, setPdfSplitError] = useState('')
  const [isPdfSplitConfirming, setIsPdfSplitConfirming] = useState(false)
  const pdfSplitConfirmingRef = useRef(false)
  const { fetchDimensions, isFetchingDimensions } = useEmbeddingDimensions()
  const handleSettingsNavigate = useCloseBeforeAction(onOpenChange)

  useEffect(() => {
    setValues(createInitialValues(defaultName, initialEmbeddingModelId))
    setHasAttemptedSubmit(false)
    setSubmitError(null)
    setPendingRestoreInput(null)
    setPdfSplitState({ status: 'closed' })
    setPdfSplitError('')
    setIsPdfSplitConfirming(false)
    pdfSplitConfirmingRef.current = false
  }, [base.id, defaultName, initialEmbeddingModelId, open])

  const handleEmbeddingModelChange = (embeddingModelId: string | null) => {
    setValues((currentValues) => ({ ...currentValues, embeddingModelId }))
    setSubmitError(null)
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setHasAttemptedSubmit(true)
    setSubmitError(null)

    if (!values.name.trim()) {
      return
    }

    let dimensions: number | null = null

    if (values.embeddingModelId) {
      try {
        dimensions = await fetchDimensions(values.embeddingModelId)
      } catch (error) {
        setSubmitError(formatErrorMessageWithPrefix(error, t('message.error.get_embedding_dimensions')))
        return
      }
    }

    const restoreInput: RestoreKnowledgeBaseInput = {
      sourceBaseId: base.id,
      name: values.name,
      embeddingModelId: values.embeddingModelId,
      dimensions
    }
    setPendingRestoreInput(restoreInput)
    setPdfSplitState({ status: 'preparing', fileNames: [base.name] })

    let result: RestoreKnowledgeBaseResult

    try {
      result = await restoreBase(restoreInput)
    } catch (error) {
      setPendingRestoreInput(null)
      setPdfSplitState({ status: 'closed' })
      setSubmitError(formatErrorMessageWithPrefix(error, t('knowledge.restore.failed_to_restore')))
      return
    }

    if (result.status === 'split_confirmation_required') {
      setPdfSplitState({ status: 'ready', confirmation: result.confirmation })
      return
    }

    finishRestore(result)
  }

  const finishRestore = (result: Extract<RestoreKnowledgeBaseResult, { status: 'restored' }>) => {
    pdfSplitConfirmingRef.current = false
    setIsPdfSplitConfirming(false)
    setPendingRestoreInput(null)
    setPdfSplitState({ status: 'closed' })

    // Restore drops root items whose source is gone (a v1-migrated directory child's virtual path,
    // a deleted file). Tell the user instead of silently restoring fewer items than expected.
    if (result.skippedMissingSourceCount > 0) {
      toast.warning(t('knowledge.restore.skipped_missing_sources', { count: result.skippedMissingSourceCount }))
    }

    onRestored(result.base)
    onOpenChange(false)
  }

  const handlePdfSplitConfirm = async () => {
    if (pdfSplitState.status !== 'ready' || !pendingRestoreInput || isRestoring || pdfSplitConfirmingRef.current) return

    pdfSplitConfirmingRef.current = true
    setIsPdfSplitConfirming(true)
    setPdfSplitError('')
    try {
      const result = await restoreBase({
        ...pendingRestoreInput,
        splitConfirmationToken: pdfSplitState.confirmation.token
      })
      if (result.status === 'split_confirmation_required') {
        pdfSplitConfirmingRef.current = false
        setIsPdfSplitConfirming(false)
        setPdfSplitState({ status: 'ready', confirmation: result.confirmation })
        return
      }
      finishRestore(result)
    } catch (error) {
      pdfSplitConfirmingRef.current = false
      setIsPdfSplitConfirming(false)
      setPdfSplitError(formatErrorMessageWithPrefix(error, t('knowledge.restore.failed_to_restore')))
    }
  }

  const handlePdfSplitCancel = () => {
    if (pdfSplitState.status !== 'ready' || isRestoring || pdfSplitConfirmingRef.current) return
    const token = pdfSplitState.confirmation.token
    setPendingRestoreInput(null)
    setPdfSplitState({ status: 'closed' })
    setPdfSplitError('')
    void ipcApi.request('knowledge.discard_split_confirmation', { token }).catch((error) => {
      logger.warn('Failed to discard restore PDF split confirmation', {
        token,
        error: error instanceof Error ? error.message : String(error)
      })
    })
  }

  return (
    <>
      <Dialog open={open && pdfSplitState.status === 'closed'} onOpenChange={onOpenChange}>
        <DialogContent closeOnOverlayClick={false} size="lg">
          <CreateKnowledgeBaseDialog.Header title={t('knowledge.restore.title')} />

          <CreateKnowledgeBaseDialog.Form onSubmit={handleSubmit}>
            <KnowledgeDialogBody>
              {failureReason ? <DialogDescription>{failureReason}</DialogDescription> : null}
              <KnowledgeDialogField>
                <Label htmlFor="knowledge-restore-name">{t('common.name')}</Label>
                <Input
                  autoFocus
                  id="knowledge-restore-name"
                  value={values.name}
                  aria-invalid={hasAttemptedSubmit && !values.name.trim()}
                  placeholder={t('common.name')}
                  onChange={(event) => setValues((currentValues) => ({ ...currentValues, name: event.target.value }))}
                />
                {hasAttemptedSubmit && !values.name.trim() ? (
                  <FieldError>{t('knowledge.name_required')}</FieldError>
                ) : null}
              </KnowledgeDialogField>

              <KnowledgeDialogField>
                <Label>{t('knowledge.embedding_model')}</Label>
                <KnowledgeEmbeddingModelSelect
                  aria-label={t('knowledge.embedding_model')}
                  value={values.embeddingModelId}
                  placeholder={t('knowledge.rag.rerank_disabled')}
                  noneOptionLabel={t('knowledge.rag.rerank_disabled')}
                  onSettingsNavigate={handleSettingsNavigate}
                  onChange={handleEmbeddingModelChange}
                />
              </KnowledgeDialogField>

              {submitError ? <FieldError>{submitError}</FieldError> : null}
            </KnowledgeDialogBody>

            <CreateKnowledgeBaseDialog.Actions
              isCreating={isRestoring || isFetchingDimensions}
              onCancel={() => onOpenChange(false)}
              cancelLabel={t('common.cancel')}
              submitLabel={t('knowledge.restore.submit')}
            />
          </CreateKnowledgeBaseDialog.Form>
        </DialogContent>
      </Dialog>
      <PdfSplitConfirmationDialog
        state={pdfSplitState}
        errorMessage={pdfSplitError}
        isConfirming={(isRestoring || isPdfSplitConfirming) && pdfSplitState.status === 'ready'}
        onCancel={handlePdfSplitCancel}
        onConfirm={() => void handlePdfSplitConfirm()}
      />
    </>
  )
}

export default RestoreKnowledgeBaseDialog
