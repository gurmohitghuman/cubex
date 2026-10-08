import React, { useEffect, useState } from 'react'
import { autorunAPI, type AutorunEstimate } from '@/utils/api'
import { AUTORUN_IMPORT_COUNT_BYTES } from '@/lib/constants'
import { countCsvRows } from './countCsvRows'
import { noticeLine, type Count } from './notice-copy'

interface Props {
  sheetId: string
  file: File
  paused: boolean
  onPausedChange: (paused: boolean) => void
  disabled: boolean
  // false while the notice is still working out what the rows set off: the import waits for it.
  onReady: (ready: boolean) => void
}

// The CSV import's auto-run notice: with auto-run on in this sheet, the
// imported rows are new rows it fills (or fills on resume, when paused), so it
// says what they could cost (or that each sends a request), with a toggle to
// leave these rows alone. The import waits until it has said so.
export const ImportAutorunNotice: React.FC<Props> = ({ sheetId, file, paused, onPausedChange, disabled, onReady }) => {
  const [count, setCount] = useState<Count | null>(null)
  const [estimate, setEstimate] = useState<AutorunEstimate | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    setCount(null); setEstimate(null); setFailed(false); onReady(false)
    countCsvRows(file, AUTORUN_IMPORT_COUNT_BYTES)
      .then(c => { if (alive) setCount(c); return autorunAPI.estimate(sheetId, c.rows) })
      .then(e => { if (alive) setEstimate(e) })
      .catch(() => { if (alive) setFailed(true) })
      .finally(() => { if (alive) onReady(true) })
    return () => { alive = false; onReady(true) }
  }, [sheetId, file]) // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (
    <label className="flex items-start gap-2 text-sm text-gray-800">
      <input type="checkbox" checked={paused} disabled={disabled} onChange={e => onPausedChange(e.target.checked)}
        className="mt-0.5 border-gray-300 text-cube-black focus:ring-black" />
      <span>
        Pause auto-run for this import
        <span className="block text-xs text-gray-600">
          Auto-run leaves these rows alone. Rows added later still run.
        </span>
      </span>
    </label>
  )
  if (failed) {
    return (
      <div className="bg-amber-50 border border-amber-200 px-3 py-2.5 space-y-2" data-testid="import-autorun-notice">
        <p className="text-sm text-amber-900">
          Couldn&apos;t check what auto-run would do with these rows. Auto-run is on in this sheet.
        </p>
        {toggle}
      </div>
    )
  }
  if (!estimate || !count) {
    return (
      <p className="text-sm text-gray-600 bg-gray-50 border border-gray-200 px-3 py-2.5"
        data-testid="import-autorun-checking">Checking what auto-run would do with these rows…</p>
    )
  }
  if (count.rows === 0 || estimate.autoRuns.length === 0) return null
  return (
    <div className="bg-amber-50 border border-amber-200 px-3 py-2.5 space-y-2" data-testid="import-autorun-notice">
      {estimate.autoRuns.map(a => <p key={a.column} className="text-sm text-amber-900">{noticeLine(a, count)}</p>)}
      {toggle}
    </div>
  )
}
