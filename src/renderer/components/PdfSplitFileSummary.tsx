import { formatFileSize } from '@renderer/utils/file'
import type { KnowledgePdfSplitConfirmation } from '@shared/data/types/knowledge'
import { useTranslation } from 'react-i18next'

interface PdfSplitFileSummaryProps {
  confirmation: KnowledgePdfSplitConfirmation
  className?: string
}

const PdfSplitFileSummary = ({ confirmation, className }: PdfSplitFileSummaryProps) => {
  const { t } = useTranslation()

  return (
    <ul className={className}>
      {confirmation.files.map((file, index) => (
        <li key={`${file.sourceName}-${index}`} className="border-border border-b pb-2 last:border-b-0">
          <div className="truncate font-medium text-sm" title={file.sourceName}>
            {file.sourceName}
          </div>
          <div className="mt-0.5 text-foreground-tertiary text-xs">
            {t('knowledge.data_source.pdf_split.file_summary', {
              pages: file.pageCount,
              size: formatFileSize(file.sourceBytes),
              parts: file.parts.length
            })}
          </div>
        </li>
      ))}
    </ul>
  )
}

export default PdfSplitFileSummary
