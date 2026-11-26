import React, { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import Modal from '@/components/Modal'
import { sheetTestAPI, type ApplyTestAnswer, type SheetTestView } from '@/utils/api/sheet-test'
import type { ColumnKind } from '@/utils/api/setup-versions'

// "Apply to <sheet>": what applying the test would do (its dry run, asked for as the dialog opens), then Apply.
// The copy's setup becomes the sheet's (the old one is kept as a setup version), the sample rows keep the results
// the new setup made, and changed clean, formula and lookup columns are worked out again. Nothing paid runs.
const KIND: Partial<Record<ColumnKind, string>> = {
  ai: 'AI', http: 'HTTP API', enrichment: 'Enrichment', waterfall: 'Waterfall', clean: 'Clean data',
  formula: 'Formula', lookup: 'Lookup',
}
const errorOf = (e: any): string => e?.response?.data?.error || 'Couldn\'t reach the server. Try again.'
const rows = (n: number) => `${n} sample row${n === 1 ? '' : 's'}`

const List: React.FC<{ title: string; items: Array<{ column: string; kind?: ColumnKind; kept?: number }> }> =
  ({ title, items }) => (items.length > 0 && (
    <section className="mt-3">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">{title}</h4>
      <ul className="mt-1 space-y-1">
        {items.map(c => (
          <li key={c.column} className="flex items-center gap-2 text-sm text-gray-900">
            <span className="truncate" title={c.column}>{c.column}</span>
            {c.kind && KIND[c.kind] && (
              <span className="shrink-0 text-[11px] text-gray-600 bg-gray-100 rounded px-1.5 py-0.5">
                {KIND[c.kind]}</span>
            )}
            {!!c.kept && <span className="text-xs text-gray-600">keeps the results of {rows(c.kept)}</span>}
          </li>
        ))}
      </ul>
    </section>
  )) || null

export const ApplyTestDialog: React.FC<{
  test: SheetTestView | null; onClose: () => void; onApplied: (answer: ApplyTestAnswer) => void
}> = ({ test, onClose, onApplied }) => {
  const [plan, setPlan] = useState<ApplyTestAnswer | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  useEffect(() => {
    if (!test) return
    let live = true
    setPlan(null); setError(null)
    sheetTestAPI.apply(test.sheet_id, true).then(p => { if (live) setPlan(p) })
      .catch(e => { if (live) setError(errorOf(e)) })
    return () => { live = false }
  }, [test])
  const apply = async () => {
    if (!test) return
    setApplying(true); setError(null)
    try {
      onApplied(await sheetTestAPI.apply(test.sheet_id, false))
    } catch (e) {
      setError(errorOf(e))
    } finally {
      setApplying(false)
    }
  }
  const name = test?.sheet_name ?? ''
  const kept = plan?.results_kept ?? {}
  const of = (action: 'restore' | 'add_back') => (plan?.columns ?? []).filter(c => c.action === action)
    .map(c => ({ column: c.column, kind: c.kind, kept: kept[c.column] }))
  return (
    <Modal isOpen={!!test} onClose={() => { if (!applying) onClose() }} panelClassName="max-w-lg w-full">
      <div data-testid="apply-test-dialog">
        <div className="px-6 pt-5 pb-3 border-b border-gray-200">
          <h3 className="text-title text-gray-900 truncate">Apply the test to {name}</h3>
        </div>
        <div className="px-6 py-4 max-h-[55vh] overflow-y-auto">
          {!plan && !error && (
            <p className="flex items-center gap-2 text-sm text-gray-600" data-testid="apply-test-loading">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Comparing the test with {name}…
            </p>
          )}
          {plan && (
            <>
              <p className="text-sm text-gray-800" data-testid="apply-test-message">{plan.blocked ?? plan.message}</p>
              <List title="Set up as in the test" items={of('restore')} />
              <List title="Added" items={of('add_back')} />
              {plan.worked_out_again.length > 0 && (
                <p className="text-xs text-gray-600 mt-3">
                  Worked out again on every row, free: {plan.worked_out_again.join(', ')}.</p>
              )}
              {plan.not_in_test.length > 0 && (
                <p className="text-xs text-gray-600 mt-2">
                  Deleted in the test, so they stay on {name}: {plan.not_in_test.join(', ')}.</p>
              )}
              {!plan.blocked && !plan.nothing && (
                <p className="text-xs text-gray-600 mt-3">
                  {name}'s setup now is saved as a version first. Nothing runs on its other rows: run the changed
                  columns from their menus when you're ready.</p>
              )}
            </>
          )}
          {error && <p className="text-sm text-red-700 bg-red-50 rounded px-3 py-2" role="alert">{error}</p>}
        </div>
        <div className="px-6 py-3 border-t border-gray-200 flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={applying}>Cancel</button>
          <button type="button" className="btn-primary flex items-center gap-1.5" onClick={() => { void apply() }}
            disabled={!plan || !!plan.blocked || applying} data-testid="apply-test-confirm">
            {applying && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            {plan?.nothing ? 'Close the test' : 'Apply'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
