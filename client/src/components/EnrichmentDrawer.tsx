import React, { useEffect, useMemo, useState } from 'react'
import { DatabaseZap } from 'lucide-react'
import { settingsAPI } from '@/utils/api'
import { Drawer, DrawerHeader } from './Drawer'
import { FindStep } from './enrich-modal/FindStep'
import { SetupStep } from './enrich-modal/SetupStep'
import { pickTool } from './enrich-modal/draft'
import { useEnrichmentDraft } from './enrich-modal/useEnrichmentDraft'

interface Props {
  isOpen: boolean
  onClose: () => void
  sheetId: string
  // The sheet's columns (the registry), for inputs, names and conditions.
  columns: string[]
  // The rows the grid has loaded, to tell which columns hold values.
  loadedRows: Array<{ data: Record<string, string> }>
  // Row indexes of the selected rows ("Selected rows" mode).
  selectedRows: number[]
  rowGeneration?: number
  // A run started: follow it in the grid (SSE, reload); the drawer closes.
  onRunStarted: (runId: string) => void
}

// "Add enrichment": pick a job (Find), then map it to the sheet (Set up). Like
// the AI Column drawer, a narrow right-side panel. Its state is kept per sheet
// while the page is open, so closing and reopening resumes where you were.
export const EnrichmentDrawer: React.FC<Props> = ({ isOpen, onClose, sheetId, columns, loadedRows, selectedRows, rowGeneration, onRunStarted }) => {
  const { draft, update } = useEnrichmentDraft(sheetId)
  // Read when Set up builds its defaults; recomputed only while the drawer is open.
  const filledColumns = useMemo(() => {
    if (!isOpen || loadedRows.length === 0) return null
    return new Set(columns.filter(c => loadedRows.some(r => (r.data[c] ?? '').trim() !== '')))
  }, [isOpen, columns, loadedRows])
  // undefined while loading; the key can change in Settings, so read it on each open.
  const [hasKey, setHasKey] = useState<boolean | undefined>(undefined)
  useEffect(() => {
    if (!isOpen) return
    let alive = true
    settingsAPI.get().then(s => { if (alive) setHasKey(!!s.hasTregKey) }).catch(() => {})
    return () => { alive = false }
  }, [isOpen])

  const step = draft.card ? draft.step : 'find'
  return (
    <Drawer isOpen={isOpen} onClose={onClose} panelClassName="max-w-lg">
      <DrawerHeader
        icon={<div className="bg-cube-black p-1.5"><DatabaseZap className="h-4 w-4 text-white" /></div>}
        title="Add enrichment"
        description={step === 'find' ? 'Pick what you want to find' : `Set up ${draft.card?.title ?? ''}`}
        onClose={onClose}
      />
      <div className="flex-1 overflow-y-auto" data-testid="enrich-drawer">
        {step === 'find' ? (
          <FindStep query={draft.query} setQuery={query => update({ query })} hasKey={hasKey} active={isOpen}
            onPick={card => update(d => pickTool(d, card))} />
        ) : (
          <SetupStep sheetId={sheetId} draft={draft} update={update} columns={columns} selectedCount={selectedRows.length}
            selectedRows={selectedRows} rowGeneration={rowGeneration} filledColumns={filledColumns} hasKey={hasKey} active={isOpen}
            onChangeTool={() => update({ step: 'find' })} onCancel={onClose} onRunStarted={onRunStarted} />
        )}
      </div>
    </Drawer>
  )
}
