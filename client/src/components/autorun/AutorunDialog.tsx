import React, { useEffect, useRef, useState } from 'react'
import { Zap } from 'lucide-react'
import { Modal } from '@/components/Modal'
import { autorunAPI, type EnrichDailyLimit } from '@/utils/api'
import type { AutorunColumn, AutorunTargetInfo, SheetAutorun } from '@/utils/api/types-autorun'
import { MoneyInput } from '@/components/enrich-modal/MoneyInput'
import { RunIfField } from '@/components/run-if/RunIfField'
import { limitText, utcMidnightLocal } from '@/lib/enrich-format'
import {
  AUTORUN_DEFAULT_DAILY_CAP_USD, AUTORUN_HTTP_DEFAULT_DAILY_ROWS, AUTORUN_HTTP_MAX_DAILY_ROWS,
} from '@/lib/constants'
import { capFix, pauseLabel, pauseSentence, webhookWarning } from './autorun-copy'

export interface AutorunTarget { column: string; kind: 'enrichment' | 'http' | 'waterfall' }

// Mounted per open (the parent keys it), so its fields start from `current`.
interface Props {
  target: AutorunTarget
  sheetId: string
  current?: AutorunColumn
  hasWebhook: boolean
  onClose: () => void
  onSaved: (view: SheetAutorun) => void
}

// "Turn On Auto-run" from the column menu (and the header chip's Settings):
// auto-run repeats the column's newest run on new rows and rows whose inputs
// get filled, once per row, under "Only run if" and a daily cap: dollars for
// an enrichment, rows for an HTTP API column (each row sends a real request).
export const AutorunDialog: React.FC<Props> = ({ target, sheetId, current, hasWebhook, onClose, onSaved }) => {
  // "Only run if" (older condition lists come as one rule). A first turn-on
  // starts from the column's newest run's rule (read below); until that read
  // lands and while untouched, the server's default stands.
  const [runIf, setRunIfState] = useState(current?.runIf ?? '')
  const [runIfKnown, setRunIfKnown] = useState(!!current)
  const touched = useRef(false)
  const setRunIf = (r: string) => { touched.current = true; setRunIfKnown(true); setRunIfState(r) }
  const [capUsd, setCapUsd] = useState<number | null>(current?.dailyCapUsd ?? null)
  const [rowsText, setRowsText] = useState(String(current?.dailyRowCap ?? AUTORUN_HTTP_DEFAULT_DAILY_ROWS))
  const [limit, setLimit] = useState<EnrichDailyLimit | null>(null)
  const [info, setInfo] = useState<AutorunTargetInfo | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const on = !!current?.enabled

  useEffect(() => {
    let alive = true
    autorunAPI.get(sheetId, target.column).then(v => {
      if (!alive) return
      setLimit(v.dailyLimit); setInfo(v.target ?? null)
      // A first turn-on starts from the column's own "Only run if".
      if (!current && !touched.current && v.target) { setRunIfState(v.target.runIf ?? ''); setRunIfKnown(true) }
    }).catch(() => {})
    return () => { alive = false }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // A waterfall with only free steps is capped in rows a day, as an HTTP API column.
  const http = target.kind === 'http' || (target.kind === 'waterfall' && !!info?.rowCap)
  const rows = Number(rowsText)
  const rowsProblem = http && !(Number.isInteger(rows) && rows >= 1 && rows <= AUTORUN_HTTP_MAX_DAILY_ROWS)
    ? `Rows a day must be a whole number from 1 to ${AUTORUN_HTTP_MAX_DAILY_ROWS.toLocaleString()}.` : null
  // "Only run if" can't read this column's own outputs: the server refuses that, and the rule box shows why.
  const problem = rowsProblem
  const cap = capUsd ?? Math.min(AUTORUN_DEFAULT_DAILY_CAP_USD, limit?.limitUsd ?? AUTORUN_DEFAULT_DAILY_CAP_USD)
  const paused = current?.pausedReason ?? null
  // The team's own provider key bills the tool: no dollar cap, until treg prices it ('priced').
  const noCap = !http && !!info?.ownKey && paused !== 'priced'

  const act = async (call: () => Promise<SheetAutorun>) => {
    setSaving(true)
    setError(null)
    try {
      onSaved(await call())
      onClose()
    } catch (e: any) {
      setError(e?.response?.data?.error || "Couldn't save auto-run. Try again.")
    } finally {
      setSaving(false)
    }
  }
  // An own-key column keeps a cap set before (for when treg prices the tool).
  const kept = current?.dailyCapUsd ?? null
  const capBody = noCap ? (kept !== null ? { dailyCapUsd: kept } : {}) : { dailyCapUsd: cap }
  const save = () => {
    if (problem) return
    void act(() => autorunAPI.save(sheetId, {
      // A rule read here replaces an older condition list (it came back as that rule).
      column: target.column, enabled: true, ...(runIfKnown ? { where: [], runIf } : {}),
      ...(http ? { dailyRowCap: rows } : capBody),
    }))
  }

  return (
    <Modal isOpen onClose={onClose} panelClassName="max-w-lg">
      <div className="p-6 space-y-4" data-testid="autorun-dialog" data-kind={target.kind}>
        <div className="flex items-start gap-3">
          <div className="bg-cube-black p-1.5"><Zap className="h-4 w-4 text-white" /></div>
          <div>
            <h3 className="text-title text-gray-900">Run &quot;{target.column}&quot; automatically</h3>
            <p className="text-sm text-gray-600 mt-1">
              It runs on new rows and rows whose inputs get filled, once per row. Rows it already ran
              aren&apos;t run again when you edit them.
            </p>
          </div>
        </div>
        {http && (
          <p className="text-sm text-gray-700">
            It sends a real request for each row (for example, adding a lead), when every column the request
            uses is filled.
          </p>
        )}
        {current && paused && (
          <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 px-3 py-2"
            data-testid="autorun-paused">
            {pauseLabel(paused)}. {pauseSentence(current)}{capFix(paused) ? ` ${capFix(paused)}` : ''}
          </p>
        )}
        <RunIfField sheetId={sheetId} value={runIf} onChange={setRunIf} active
          skippedNote="Rows that don't pass wait, with no marker, until a column the rule reads changes." />
        {http ? (
          <div className="space-y-1">
            <label className="flex items-center gap-2 text-sm text-gray-700">
              At most
              <input className={`input w-24 py-1 ${rowsProblem ? '!border-red-300' : ''}`} inputMode="numeric"
                value={rowsText} aria-label="Rows a day"
                onChange={e => setRowsText(e.target.value.replace(/[^\d]/g, ''))} />
              rows a day
            </label>
            {rowsProblem && <p className="text-xs text-red-600">{rowsProblem}</p>}
          </div>
        ) : noCap ? (
          <p className="text-xs text-gray-600" data-testid="autorun-own-key">
            No daily cap: the provider bills this tool on your own key at treg, not your treg balance. If
            treg starts pricing it, auto-run pauses until you set a cap.
          </p>
        ) : (
          <div className="space-y-1">
            <label className="flex flex-wrap items-center gap-2 text-sm text-gray-700">
              Spend at most
              <MoneyInput value={capUsd} fallback={cap} label="Daily cap" onChange={setCapUsd} />
              a day on this column
            </label>
            <p className="text-xs text-gray-500">
              {limit?.limitUsd != null
                ? `Your daily limit for all enrichments (${limitText(limit.limitUsd)}) stops it sooner if reached. `
                : ''}
              Both reset at midnight UTC ({utcMidnightLocal()} your time).
            </p>
          </div>
        )}
        {hasWebhook && (
          <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 px-3 py-2"
            data-testid="autorun-webhook">
            {webhookWarning(target.kind, limit?.limitUsd ?? null, noCap)}
          </p>
        )}
        <div className="flex items-center justify-between gap-2 pt-1">
          <div className="flex gap-2">
            {on && (
              <button type="button" className="btn-secondary" disabled={saving}
                onClick={() => act(() => autorunAPI.save(sheetId, { column: target.column, enabled: false }))}>
                Turn off
              </button>
            )}
            {on && !paused && (
              <button type="button" className="btn-secondary" disabled={saving}
                onClick={() => act(() => autorunAPI.pause(sheetId, true, target.column))}>
                Pause
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
            <button type="button" className="btn-primary" disabled={saving || !!problem} onClick={save}>
              {on && paused ? 'Save and resume' : on ? 'Save' : 'Turn on'}
            </button>
          </div>
        </div>
        {on && (
          <p className="text-xs text-gray-500">
            Pause keeps the rows added meanwhile for later. Turn off skips them: turned on again, it starts
            from the rows there then.
          </p>
        )}
        {(error || (problem && !rowsProblem)) && (
          <p className="text-xs text-red-600 text-right">{error ?? problem}</p>
        )}
      </div>
    </Modal>
  )
}
