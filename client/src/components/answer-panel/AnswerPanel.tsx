import React, { useEffect, useMemo, useRef } from 'react'
import { Copy, DatabaseZap, Globe, Loader2, RotateCcw } from 'lucide-react'
import { Drawer, DrawerBody, DrawerHeader } from '@/components/Drawer'
import { JsonTree } from '@/components/json-mapping/JsonTree'
import type { AnswerView } from '@/utils/api'
import { AnswerSteps, Section } from './AnswerSteps'
import { costLine, foundLine, keptNotice, statusLine } from './answer-copy'

// rowGeneration: the sheet's when the panel opened, so "Rerun this row" can't
// run a row a sort has moved since.
export interface AnswerTarget {
  sheetId: string; column: string; row: number; displayRow: number; rowGeneration?: number
}

interface Props {
  target: AnswerTarget | null
  view: AnswerView | null
  loading: boolean
  error: string | null
  adding: boolean
  addError: string | null
  added: string | null
  diagText: string | null
  onClose: () => void
  onAddField: (jsonPath: string, name: string) => void
  onRerun: () => void
  onCopy: () => void
}

const FREE_HINT = {
  enrichment: '+ Column adds a column filled from the answers you already have. Free: no new calls to treg.',
  http: '+ Column adds a column filled from the responses you already have. Free: no new requests.',
}
// A list job's answer: its results become rows elsewhere (once fields are
// picked, once that sheet has room, or once a paused run there goes on or
// stops), as the row's status cell says.
function listHint(dest: string | null, statusCell: string): string {
  const cell = statusCell.trim()
  if (!dest) return 'These results were for a sheet that was deleted since.'
  if (cell.includes('waiting for fields')) {
    return `These results become rows in ${dest} once you pick the fields to keep.`
  }
  if (cell.includes('waiting for room')) return `These results become rows in ${dest} once it has room.`
  if (cell.includes('is paused')) {
    return `These results become rows in ${dest} once the paused run there is resumed and done, or cancelled.`
  }
  if (cell.startsWith('➕')) return `These results are being added as rows in ${dest}.`
  if (cell.startsWith('✅')) {
    return /rows? added/.test(cell) ? `These results became rows in ${dest}.`
      : `These results were already in ${dest}, so none were added.`
  }
  if (cell.startsWith('⏭') && cell.includes('Not found')) return 'This row returned no results.'
  return `No rows were added to ${dest}.`
}

// A cell's answer (its details): who found it and what it cost, the
// row's result, each step, and the whole answer as text, where any value can
// become a column. HTTP API columns get the result and the full response.
export const AnswerPanel: React.FC<Props> = (p) => {
  const v = p.view
  const mapped = useMemo(() => new Map((v?.mapping ?? []).map(m => [m.jsonPath, m.columnName])), [v])
  const enrich = v?.kind === 'enrichment'
  const notice = v ? keptNotice(v) : null
  // The add's outcome shows above a tree that can be long: bring it into view.
  const outcomeRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (p.addError || p.added) outcomeRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [p.addError, p.added])
  // So is the diagnostics text, shown where the browser can't copy it.
  const diagRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (p.diagText) diagRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [p.diagText])
  const headline = v ? foundLine(v) ?? (v.status === 'completed' ? statusLine(v) : null) : null
  return (
    <Drawer isOpen={!!p.target} onClose={p.onClose} panelClassName="max-w-lg">
      <div className="flex flex-col h-full" data-testid="answer-panel">
        <DrawerHeader
          icon={v?.kind === 'http' ? <Globe className="h-5 w-5" /> : <DatabaseZap className="h-5 w-5" />}
          title={p.target ? `Row ${p.target.displayRow} · ${p.target.column}` : ''}
          description={v ? (v.enrichment ? v.enrichment.toolName : 'HTTP API column') : undefined}
          onClose={p.onClose}
        />
        <DrawerBody>
          {p.loading && !v && (
            <p className="text-sm text-gray-600 flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />
              Loading the answer…</p>
          )}
          {p.error && <p className="text-sm text-gray-700" data-testid="answer-error">{p.error}</p>}
          {p.diagText && (
            <div ref={diagRef} className="space-y-1" data-testid="answer-diagnostics">
              <p className="text-xs text-gray-600">This browser can&apos;t copy here. Select the text and copy it.</p>
              <textarea readOnly rows={6} className="input w-full text-xs font-mono" value={p.diagText}
                onFocus={e => e.currentTarget.select()} aria-label="Diagnostics" />
            </div>
          )}
          {v && (
            <>
              {(enrich || v.status === 'failed') && (
                <div className="bg-gray-50 border border-gray-200 p-3 space-y-1 text-sm" data-testid="answer-summary">
                  {headline && <p className="font-medium text-gray-900">{headline}</p>}
                  {v.status === 'failed' && (
                    <p className="text-red-700">{v.reason ? `Failed: ${v.reason}` : 'This row failed.'}</p>
                  )}
                  {costLine(v) && <p className="text-gray-700" data-testid="answer-cost">{costLine(v)}</p>}
                </div>
              )}
              <Section title="Result" testId="answer-result">
                <dl className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-3 gap-y-1 text-sm">
                  {v.result.map(r => (
                    <React.Fragment key={r.column}>
                      <dt className="text-gray-600 truncate" title={r.column}>{r.column}</dt>
                      <dd className="text-gray-900 break-words">
                        {r.value || <span className="text-gray-400">empty</span>}
                      </dd>
                    </React.Fragment>
                  ))}
                </dl>
              </Section>
              {v.enrichment && <AnswerSteps e={v.enrichment} />}
              <Section title={enrich ? 'Full answer' : 'Full response'} testId="answer-full">
                <p className="text-xs text-gray-600 mb-2" data-testid="answer-hint">
                  {v.addsRowsTo ? listHint(v.addsRowsTo.name, v.result[0]?.value ?? '') : FREE_HINT[v.kind]}
                </p>
                {notice && <p className="text-xs bg-amber-50 border border-amber-200 text-amber-800 p-2 mb-2"
                  data-testid="answer-kept-notice">{notice}</p>}
                <div ref={outcomeRef} />
                {p.addError && <p className="text-xs bg-red-50 border border-red-200 text-red-700 p-2 mb-2"
                  data-testid="answer-add-error" role="alert">{p.addError}</p>}
                {p.added && <p className="text-xs bg-green-50 border border-green-200 text-green-800 p-2 mb-2"
                  data-testid="answer-added">
                  Adding {p.added}. Its cells show ⏳ until every row is filled. Rows whose answer lacks this value
                  stay empty.
                </p>}
                {v.answer === null || v.answer === undefined
                  ? <p className="text-sm text-gray-500">Nothing was kept for this row.</p>
                  : (
                    <div className={`text-xs font-mono overflow-x-auto border border-gray-200 p-2${
                      p.adding ? ' opacity-60 pointer-events-none' : ''}`} data-testid="answer-tree">
                      <JsonTree value={v.answer} path="$" mappingByPath={mapped}
                        onPick={v.addsRowsTo ? undefined : p.onAddField} pickLabel="Column" />
                    </div>
                  )}
              </Section>
            </>
          )}
        </DrawerBody>
        <div className="border-t border-gray-200 px-4 py-3 flex items-center justify-between gap-2 flex-shrink-0">
          <div className="min-w-0">
            {enrich && (
              <>
                <button type="button" className="btn-secondary inline-flex items-center gap-1.5 whitespace-nowrap"
                  onClick={p.onRerun} data-testid="answer-rerun">
                  <RotateCcw className="h-4 w-4" /> Rerun this row
                </button>
                <p className="text-[11px] text-gray-500 mt-1">Calls treg again for this row, and it costs again.</p>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            {v && (
              <button type="button" className="btn-secondary inline-flex items-center gap-1.5 whitespace-nowrap"
                onClick={p.onCopy} data-testid="answer-copy">
                <Copy className="h-4 w-4" /> Copy diagnostics
              </button>
            )}
            <button type="button" className="btn-primary" onClick={p.onClose}>Close</button>
          </div>
        </div>
      </div>
    </Drawer>
  )
}
