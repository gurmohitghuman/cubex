import React from 'react'
import { SkipForward } from 'lucide-react'
import { DrawerBody, DrawerHeader } from '@/components/Drawer'
import { PanelWait, SidePanel } from '@/components/SidePanel'
import type { SkipWhy } from '@/utils/api/skip-why'
import type { WhyTarget } from '@/hooks/sheet/useWhyPanel'

interface Props {
  target: WhyTarget | null
  // The reasons on screen; `stale`: they are another cell's, this one's are on their way.
  why: SkipWhy | null
  stale: boolean
  loading: boolean
  error: string | null
  onClose: () => void
  onDoubleClickThrough: () => void
  slideIn?: boolean
}

const BY: Record<SkipWhy['rules'][number]['by'], string> = { run: 'Only run if', auto_run: 'Auto-run\'s Only run if' }

// Why a row didn't run: the rule, and each part of it the row fails, with what the cell holds. A side panel: the
// grid stays usable beside it.
export const WhyPanel: React.FC<Props> = ({
  target, why, stale, loading, error, onClose, onDoubleClickThrough, slideIn,
}) => (
  <SidePanel isOpen={!!target} onClose={onClose} onDoubleClickThrough={onDoubleClickThrough} slideIn={slideIn}
    label={target ? `Row ${target.displayRow.toLocaleString()} · ${target.column}` : ''}
    openKey={target ? `${target.sheetId}:${target.column}:${target.row}` : undefined}>
    <DrawerHeader icon={<div className="bg-cube-black p-1.5"><SkipForward className="h-4 w-4 text-white" /></div>}
      title={target ? `Row ${target.displayRow.toLocaleString()}: why it didn't run` : ''}
      description={target?.column ?? ''} onClose={onClose}
      headerRight={loading && why ? <PanelWait label="Checking this row" /> : undefined} />
    <DrawerBody topKey={target ? `${target.column}:${target.row}` : ''}>
      <div className="space-y-4 text-sm" data-testid="skip-why" data-stale={stale ? 'true' : undefined}>
        {error && <p className="text-red-600">{error}</p>}
        {!why && !error && <p className="text-gray-500">Checking this row…</p>}
        {why && !why.has_rule && (
          <p className="text-gray-700">This column has no "Only run if" rule now, so this row would run next time.</p>
        )}
        {why && why.has_rule && why.passes_now && (
          <p className="text-gray-700" data-testid="skip-why-passes">
            This row passes "Only run if" now: its cells changed since. Run it again (▶ on the cell) to fill it.
          </p>
        )}
        {why?.rules.map(r => (
          <section key={r.by} className="space-y-2" data-testid="skip-why-rule">
            <p className="text-gray-500">{BY[r.by]}: <code className="text-gray-900">{r.rule}</code></p>
            <ul className="list-disc pl-5 space-y-1 text-gray-900">
              {r.why.map(w => <li key={w}>{w}</li>)}
            </ul>
          </section>
        ))}
      </div>
    </DrawerBody>
  </SidePanel>
)
