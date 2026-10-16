import { useCallback, useState } from 'react'
import type { SourcesCell } from '@/components/ScrapedDataModal'
import type { EnrichOpenRequest, EnrichOpenTarget } from '@/components/enrich-modal/useOpenRequest'
import type { CleanOpenTarget } from '@/components/clean/useCleanForm'
import type { FormulaOpenTarget } from '@/components/formula/useFormulaForm'
import type { NewColumnOpenTarget } from '@/components/sheet/NewColumnModal'

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
  // What the column menu opens the Add Column dialog on: Clean data with the
  // column as its source, a clean column's setup to edit, or a formula
  // column's. Null: the dialog's own choice (Empty column first).
  const [newColumnOpen, setNewColumnOpen] = useState<NewColumnOpenTarget | null>(null)
  const openClean = useCallback((target: CleanOpenTarget) => {
    setNewColumnOpen(target)
    setShowNewColumnModal(true)
  }, [])
  const openFormula = useCallback((target: FormulaOpenTarget) => {
    setNewColumnOpen(target)
    setShowNewColumnModal(true)
  }, [])
  const [showWebhookDrawer, setShowWebhookDrawer] = useState(false)
  const [showDedupeModal, setShowDedupeModal] = useState(false)
  // Save as setup: open, on the column its menu was opened on (null: from the header, nothing ticked).
  const [saveSetupFor, setSaveSetupFor] = useState<{ column: string | null } | null>(null)
  const openSaveSetup = useCallback((column: string | null) => setSaveSetupFor({ column }), [])
  const [showUseSetup, setShowUseSetup] = useState(false)
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
    newColumnOpen, openClean, openFormula, clearNewColumnOpen: () => setNewColumnOpen(null),
    showWebhookDrawer, setShowWebhookDrawer,
    showDedupeModal, setShowDedupeModal,
    saveSetupFor, openSaveSetup, closeSaveSetup: () => setSaveSetupFor(null),
    showUseSetup, setShowUseSetup,
    confirmTopbarDeleteOpen, setConfirmTopbarDeleteOpen,
    scrapedDataModal, setScrapedDataModal,
  }
}
