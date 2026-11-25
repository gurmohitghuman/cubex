import React, { useState } from 'react'
import { Trash2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { webhooksAPI, type WebhookAutoDelete as Settings, type WebhookSource } from '@/utils/api/webhooks'
import { ConfirmDialog } from '../ConfirmDialog'

// Auto-delete (server services/webhook-auto-delete.ts): the sheet keeps its newest rows, and older rows the webhook
// added are deleted, not put in the trash, once every auto-run column has run on them,
// optionally once a chosen column has a result, and copied to another sheet first. A save that deletes more
// (turning it on, keeping fewer rows, no longer copying them) asks first: the rows can't be restored.
const KEEP_DEFAULT = 100
const KEEP_MAX = 100_000

const ago = (iso: string | null): string => {
  if (!iso) return ''
  const s = Math.max(0, (Date.now() - Date.parse(`${iso.replace(' ', 'T')}Z`)) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

function describe(a: Settings): string {
  const after = a.successColumn ? ` and "${a.successColumn}" has a result` : ''
  const copy = a.copyToSheet ? `, copied to "${a.copyToSheet}" first` : ''
  return `Keeps the newest ${a.keepRows.toLocaleString()} rows. Older rows the webhook added are deleted once every `
    + `column with auto-run on has run on them${after}${copy}.`
}

export function WebhookAutoDelete({ sheetId, source, onSource, columns, sheets }: {
  sheetId: string
  source: WebhookSource
  onSource: (source: WebhookSource) => void
  // The sheet's columns (the success column), and the table's other sheets (where rows can be copied).
  columns: string[]
  sheets: Array<{ id: string; name: string }>
}) {
  const a = source.autoDelete
  const [editing, setEditing] = useState(false)
  const [keep, setKeep] = useState(String(a?.keepRows ?? KEEP_DEFAULT))
  const [success, setSuccess] = useState(a?.successColumn ?? '')
  const [copyTo, setCopyTo] = useState(a?.copyToSheetId ?? '')
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)

  const open = () => {
    setKeep(String(a?.keepRows ?? KEEP_DEFAULT))
    setSuccess(a?.successColumn ?? '')
    setCopyTo(a?.copyToSheetId ?? '')
    setEditing(true)
  }
  const keepRows = Number(keep)
  const keepOk = keep.trim() !== '' && Number.isInteger(keepRows) && keepRows >= 0 && keepRows <= KEEP_MAX
  const save = async () => {
    setBusy(true)
    try {
      const out = await webhooksAPI.setAutoDelete(sheetId,
        { keepRows, successColumn: success || null, copyToSheetId: copyTo || null })
      onSource(out.source)
      setEditing(false)
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'Could not save auto-delete.')
    } finally { setBusy(false) }
  }
  const off = async () => {
    setBusy(true)
    try {
      onSource((await webhooksAPI.removeAutoDelete(sheetId)).source)
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'Could not turn auto-delete off.')
    } finally { setBusy(false) }
  }
  // A destination no longer in this table, or a success column gone from the sheet, still shows, by name.
  const copyChoices = a?.copyToSheetId && !sheets.some(s => s.id === a.copyToSheetId)
    ? [...sheets, { id: a.copyToSheetId, name: a.copyToSheet ?? 'A sheet no longer there' }] : sheets
  const successChoices = columns.filter(c => c !== source.rawColumnName).map(c => ({ value: c, label: c }))
  if (a?.successColumn && !columns.includes(a.successColumn)) {
    successChoices.push({ value: a.successColumn, label: `${a.successColumn} (not in the sheet)` })
  }
  // Deletes more than before: asks first.
  const deletesMore = !a || keepRows < a.keepRows || (!!a.copyToSheetId && !copyTo)
  const pick = 'mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm'

  return (
    <section className="space-y-2" data-testid="webhook-auto-delete">
      <h3 className="text-sm font-semibold text-gray-900">Auto-delete</h3>
      {!editing && (a ? (
        <div className="space-y-1 text-xs text-gray-600">
          <p data-testid="webhook-auto-delete-state">{describe(a)}</p>
          {a.paused && (
            <p className="text-amber-800 bg-amber-50 border border-amber-200 px-3 py-2"
              data-testid="webhook-auto-delete-paused">Paused: {a.paused}</p>
          )}
          {a.waiting && <p className="text-gray-700" data-testid="webhook-auto-delete-waiting">{a.waiting}</p>}
          <p className="text-gray-500" data-testid="webhook-auto-delete-count">
            {a.rowsDeleted.toLocaleString()} row{a.rowsDeleted === 1 ? '' : 's'} deleted so far
            {a.lastDeletedAt ? `, the last ${ago(a.lastDeletedAt)}` : ''}.
          </p>
        </div>
      ) : (
        <p className="text-xs text-gray-600">
          Off. Keep a busy webhook sheet small: rows the webhook added, older than the newest few, are deleted
          once their auto-run columns have run, and can be copied to another sheet first.
        </p>
      ))}
      {editing ? (
        <div className="space-y-2 rounded border border-gray-200 p-3 text-xs text-gray-700">
          <label className="block">Rows to keep (the newest)
            <input type="number" min={0} max={KEEP_MAX} value={keep} onChange={e => setKeep(e.target.value)}
              className={pick} data-testid="webhook-auto-delete-keep" />
          </label>
          <label className="block">Also wait for a result in
            <select value={success} onChange={e => setSuccess(e.target.value)} className={pick}
              data-testid="webhook-auto-delete-success">
              <option value="">No column: only the auto-run columns</option>
              {successChoices.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </label>
          <label className="block">Copy rows to
            <select value={copyTo} onChange={e => setCopyTo(e.target.value)} className={pick}
              data-testid="webhook-auto-delete-copy">
              <option value="">Don&apos;t copy them</option>
              {copyChoices.filter(s => s.id !== sheetId).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <p className="text-gray-500">
            To send rows to another tool first, add an HTTP API column with auto-run that sends each row, and pick
            it above. Rows deleted this way can&apos;t be restored.
          </p>
          <div className="flex gap-2">
            <button type="button" className="btn-orange disabled:opacity-50" disabled={busy || !keepOk}
              onClick={() => (deletesMore ? setConfirm(true) : void save())} data-testid="webhook-auto-delete-save">
              {busy ? 'Saving…' : a ? 'Save' : 'Turn on'}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <button type="button" onClick={open} disabled={busy}
            className="btn-secondary flex items-center gap-1 disabled:opacity-50"
            data-testid="webhook-auto-delete-edit">
            <Trash2 className="h-3 w-3" /><span>{a ? 'Change' : 'Set up auto-delete'}</span>
          </button>
          {a && (
            <button type="button" onClick={() => void off()} disabled={busy}
              className="btn-secondary disabled:opacity-50" data-testid="webhook-auto-delete-off">Turn off</button>
          )}
        </div>
      )}
      <ConfirmDialog
        isOpen={confirm}
        title={a ? 'Save auto-delete?' : 'Turn on auto-delete?'}
        message={`Rows the webhook added, older than the newest ${keepOk ? keepRows.toLocaleString() : KEEP_DEFAULT}, `
          + 'are deleted once every column with auto-run on has run on them. They don\'t go to the trash '
          + 'and can\'t be restored.'}
        confirmText={a ? 'Save' : 'Turn on'} isDestructive zClassName="z-[20010]"
        onConfirm={() => { setConfirm(false); void save() }}
        onCancel={() => setConfirm(false)}
      />
    </section>
  )
}
