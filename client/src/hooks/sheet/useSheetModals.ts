import { useState } from 'react'
import type { SourcesCell } from '@/components/ScrapedDataModal'

export const useSheetModals = () => {
  const [showImportModal, setShowImportModal] = useState(false)
  const [showAddColumnModal, setShowAddColumnModal] = useState(false)
  const [showHTTPAPIColumnModal, setShowHTTPAPIColumnModal] = useState(false)
  const [showNewColumnModal, setShowNewColumnModal] = useState(false)
  const [showWebhookDrawer, setShowWebhookDrawer] = useState(false)
  const [confirmTopbarDeleteOpen, setConfirmTopbarDeleteOpen] = useState(false)
  const [scrapedDataModal, setScrapedDataModal] =
    useState<{ isOpen: boolean; cell: SourcesCell | null }>({ isOpen: false, cell: null })

  return {
    showImportModal, setShowImportModal,
    showAddColumnModal, setShowAddColumnModal,
    showHTTPAPIColumnModal, setShowHTTPAPIColumnModal,
    showNewColumnModal, setShowNewColumnModal,
    showWebhookDrawer, setShowWebhookDrawer,
    confirmTopbarDeleteOpen, setConfirmTopbarDeleteOpen,
    scrapedDataModal, setScrapedDataModal,
  }
}
