import React from 'react'
import { Layers, Loader2, RotateCcw } from 'lucide-react'
import { DrawerBody, DrawerHeader } from '@/components/Drawer'
import { PanelWait, SidePanel } from '@/components/SidePanel'
import type { WaterfallTrace } from '@/utils/api/waterfall'
import { formatCost } from '@/components/ai-modal/format'
import { FROM_TEXT, KIND_LABEL, OUTCOME_TEXT, checkText } from './step-copy'

export interface TraceTarget {
  sheetId: string; column: string; row: number; displayRow: number; rowGeneration?: number
}

interface Props {
  target: TraceTarget | null
  // The trace on screen and the cell it was read for. `stale`: that is another cell than target, whose trace is on
  // its way: it stays until then, and "Run this row again" waits.
  trace: WaterfallTrace | null
  shownCell: TraceTarget | null
  stale: boolean
  loading: boolean
  error: string | null
  onClose: () => void
  onDoubleClickThrough: () => void
  onRerun: () => void
  slideIn?: boolean
}

const money = (v: number) => (v === 0 ? '$0' : formatCost(v))
const WAITING = "Loading this row's trace"

// A waterfall cell's story: the value it ended with, the step that answered,
// and every step in order with what it did for this row (answered, found
// nothing, skipped for missing inputs, failed, or not reached), what it cost
// and where a free answer came from. A side panel: the grid stays usable beside it.
export const TracePanel: React.FC<Props> = ({
  target, trace: t, shownCell, stale, loading, error, onClose, onDoubleClickThrough, onRerun, slideIn,
}) => (
  <SidePanel isOpen={!!target} onClose={onClose} onDoubleClickThrough={onDoubleClickThrough} slideIn={slideIn}
    label={target ? `Row ${target.displayRow.toLocaleString()} · ${target.column}` : ''}
    openKey={target ? `${target.sheetId}:${target.column}:${target.row}` : undefined}>
    <DrawerHeader icon={<div className="bg-cube-black p-1.5"><Layers className="h-4 w-4 text-white" /></div>}
      title={target ? `Row ${target.displayRow.toLocaleString()}` : ''}
      description={`Waterfall: ${t?.resultColumn ?? target?.column ?? ''}`} onClose={onClose}
      headerRight={loading && t ? <PanelWait label={WAITING} /> : undefined} />
    <DrawerBody topKey={shownCell ? `${shownCell.column}:${shownCell.row}:${shownCell.rowGeneration ?? ''}` : ''}>
      <div className="space-y-4 text-sm" data-testid="waterfall-trace">
        {loading && !t && <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
        {error && <p className="text-red-600 text-xs">{error}</p>}
        {t && (
          <>
            <div className="space-y-0.5">
              <p className="text-gray-900 break-words">{t.value || '(empty)'}</p>
              <p className="text-xs text-gray-500">
                {t.answeredBy ? `Answered by ${t.answeredBy}` : t.reason ?? 'No step answered.'}
                {t.costUsd !== null ? ` · this row cost ${money(t.costUsd)}` : ''}
              </p>
            </div>
            <ol className="space-y-2">
              {t.steps.map((s, i) => (
                <li key={s.id} className={`border-l-2 pl-2 ${s.outcome === 'answered' ? 'border-cube-black'
                  : s.outcome === 'error' ? 'border-red-400' : 'border-gray-200'}`} data-testid="waterfall-trace-step"
                  data-outcome={s.outcome ?? 'not_reached'}>
                  <p className="text-gray-900">
                    {i + 1}. {s.label}
                    <span className="ml-1.5 text-[10px] uppercase tracking-wide text-gray-400">
                      {KIND_LABEL[s.kind]}
                    </span>
                  </p>
                  <p className="text-xs text-gray-600">
                    {!s.on ? 'Switched off' : !s.reached ? 'Not reached: an earlier step answered'
                      : OUTCOME_TEXT[s.outcome!]}
                    {s.provider ? ` · by ${s.provider}` : ''}
                    {s.cost_usd ? ` · ${money(s.cost_usd)}` : ''}
                    {s.from ? ` · ${FROM_TEXT[s.from]}` : ''}
                    {checkText(s.check)}
                  </p>
                  {s.value && <p className="text-xs font-mono text-gray-800 break-words">{s.value}</p>}
                  {s.detail && <p className="text-xs text-gray-500 break-words">{s.detail}</p>}
                </li>
              ))}
            </ol>
            <button type="button" className="btn-secondary cube-wait-dim flex items-center gap-1" onClick={onRerun}
              disabled={stale} title={stale ? WAITING : undefined} data-testid="trace-rerun">
              <RotateCcw className="h-3 w-3" /> Run this row again
            </button>
          </>
        )}
      </div>
    </DrawerBody>
  </SidePanel>
)
