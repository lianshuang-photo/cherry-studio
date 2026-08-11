import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@cherrystudio/ui'
import PdfSplitFileSummary from '@renderer/components/PdfSplitFileSummary'
import { getFileProcessorLabelKey } from '@renderer/i18n/label'
import type { KnowledgePdfSplitConfirmation } from '@shared/data/types/knowledge'
import { LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export type PdfSplitConfirmationDialogState =
  | { status: 'closed' }
  | { status: 'preparing'; fileNames: string[] }
  | { status: 'ready'; confirmation: KnowledgePdfSplitConfirmation }

interface PdfSplitConfirmationDialogProps {
  state: PdfSplitConfirmationDialogState
  errorMessage?: string
  isConfirming: boolean
  onCancel: () => void
  onConfirm: () => void
}

const PdfSplitConfirmationDialog = ({
  state,
  errorMessage,
  isConfirming,
  onCancel,
  onConfirm
}: PdfSplitConfirmationDialogProps) => {
  const { t } = useTranslation()

  if (state.status === 'closed') return null

  const confirmation = state.status === 'ready' ? state.confirmation : null
  const processorName = confirmation ? t(getFileProcessorLabelKey(confirmation.processorId)) : null

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && state.status === 'ready' && !isConfirming) onCancel()
      }}>
      <DialogContent showCloseButton={false} size="lg" className="flex max-h-[76vh] flex-col overflow-hidden">
        <DialogHeader className="text-left">
          <DialogTitle>
            {state.status === 'preparing'
              ? t('knowledge.data_source.pdf_split.preparing_title')
              : t('knowledge.data_source.pdf_split.title')}
          </DialogTitle>
          <DialogDescription>
            {state.status === 'preparing'
              ? t('knowledge.data_source.pdf_split.preparing_description')
              : t('knowledge.data_source.pdf_split.description', { processor: processorName })}
          </DialogDescription>
        </DialogHeader>

        {state.status === 'preparing' ? (
          <div role="status" className="flex min-h-20 items-center gap-3 text-muted-foreground text-sm">
            <LoaderCircle className="size-5 shrink-0 animate-spin" />
            <div className="min-w-0 space-y-1">
              {state.fileNames.map((fileName, index) => (
                <div key={`${fileName}-${index}`} className="truncate font-medium text-foreground" title={fileName}>
                  {fileName}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <PdfSplitFileSummary confirmation={state.confirmation} className="min-h-0 space-y-2 overflow-y-auto pr-1" />
        )}

        {state.status === 'ready' && errorMessage ? (
          <p role="alert" className="shrink-0 text-destructive text-sm">
            {errorMessage}
          </p>
        ) : null}

        {state.status === 'ready' ? (
          <DialogFooter>
            <Button variant="outline" onClick={onCancel} disabled={isConfirming}>
              {t('common.cancel')}
            </Button>
            <Button variant="emphasis" onClick={onConfirm} loading={isConfirming} disabled={isConfirming}>
              {t('knowledge.data_source.pdf_split.confirm')}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

export default PdfSplitConfirmationDialog
