import { useCallback, useState } from 'react'
import type { SourcesCell } from '@/components/ScrapedDataModal'
import type { EnrichOpenRequest, EnrichOpenTarget } from '@/components/enrich-modal/useOpenRequest'

export const useSheetModals = () => {
  const [showImportModal, setShowImportModal] = useState(false)
  const [showAddColumnModal, setShowAddColumnModal] = useState(false)
  const [showHTTPAPIColumnModal, setShowHTTPAPIColumnModal] = useState(false)
  const [showEnrichmentDrawer, setShowEnrichmentDrawer] = useState(false)
  // What the grid asks the enrichment drawer to open with: a column to edit
  // (it becomes the sheet's draft), or a run to watch, shown over the draft
  // without changing it (View Run, a pause toast's Show).
  const [enrichOpen, setEnrichOpen] = useState<EnrichOpenRequest | null>(null)
  const [enrichWatch, setEnrichWatch] = useState<string | null>(null)
  const openEnrichment = useCallback((target: EnrichOpenTarget) => {
    if (target.kind === 'run') { setEnrichWatch(target.runId); setEnrichOpen(null) }
    else { setEnrichWatch(null); setEnrichOpen({ ...target, nonce: Date.now() }) }
    setShowEnrichmentDrawer(true)
  }, [])
  const [showNewColumnModal, setShowNewColumnModal] = useState(false)
  const [showWebhookDrawer, setShowWebhookDrawer] = useState(false)
  const [confirmTopbarDeleteOpen, setConfirmTopbarDeleteOpen] = useState(false)
  const [scrapedDataModal, setScrapedDataModal] =
    useState<{ isOpen: boolean; cell: SourcesCell | null }>({ isOpen: false, cell: null })

  return {
    showImportModal, setShowImportModal,
    showAddColumnModal, setShowAddColumnModal,
    showHTTPAPIColumnModal, setShowHTTPAPIColumnModal,
    showEnrichmentDrawer, setShowEnrichmentDrawer,
    enrichOpen, clearEnrichOpen: () => setEnrichOpen(null), openEnrichment,
    enrichWatch, stopEnrichWatch: () => setEnrichWatch(null),
    showNewColumnModal, setShowNewColumnModal,
    showWebhookDrawer, setShowWebhookDrawer,
    confirmTopbarDeleteOpen, setConfirmTopbarDeleteOpen,
    scrapedDataModal, setScrapedDataModal,
  }
}
