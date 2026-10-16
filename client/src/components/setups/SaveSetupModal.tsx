import React from 'react'
import Modal from '@/components/Modal'
import { SETUP_KIND_LABEL } from '@/utils/api/setups'
import { useSaveSetupForm } from './useSaveSetupForm'
import { SetupPlanView } from './SetupPlanView'

const LABEL = 'block text-xs font-medium text-gray-700 mb-1'

interface Props {
  isOpen: boolean
  onClose: () => void
  sheetId: string
  // The column the menu was opened on: it and the columns it reads start ticked.
  column: string | null
}

// Save as setup: name the setup, tick the filled columns it holds, see what
// it needs from a sheet, save. Only how each column is filled is saved, never
// the rows; the sheet doesn't change.
export const SaveSetupModal: React.FC<Props> = ({ isOpen, onClose, sheetId, column }) => {
  const f = useSaveSetupForm({ sheetId, column, open: isOpen, onSaved: onClose })

  return (
    <Modal isOpen={isOpen} onClose={() => { if (!f.saving) onClose() }} panelClassName="max-w-2xl w-full">
      <div className="p-6 border-b border-gray-200">
        <h3 className="text-title text-gray-900">Save as setup</h3>
        <p className="text-sm text-gray-600 mt-1">
          Save how these columns are filled (prompts, models, requests, formulas, rules and auto-run), then build
          the same columns on another sheet in one go. Your rows aren&apos;t saved, and this sheet doesn&apos;t change.
        </p>
      </div>
      <div className="p-6 space-y-5" data-testid="save-setup-form">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label>
            <span className={LABEL}>Name</span>
            <input className="input w-full" value={f.name} onChange={e => f.setName(e.target.value)}
              placeholder="Lead scoring" maxLength={100} data-testid="setup-name" autoFocus />
          </label>
          <label>
            <span className={LABEL}>What it does (optional)</span>
            <input className="input w-full" value={f.description} onChange={e => f.setDescription(e.target.value)}
              placeholder="Finds the company, then scores the fit" maxLength={1000} />
          </label>
        </div>

        <div>
          <span className={LABEL}>Columns in the setup</span>
          {f.loadError ? (
            <p className="text-sm text-red-600">{f.loadError}</p>
          ) : !f.steps ? (
            <p className="text-sm text-gray-500">Reading the sheet&apos;s columns…</p>
          ) : f.steps.length === 0 ? (
            <p className="text-sm text-gray-600">
              This sheet has no filled columns yet. Add an AI, enrichment, HTTP API, clean data or formula column
              first.
            </p>
          ) : (
            <div className="border border-gray-200 divide-y divide-gray-100 max-h-64 overflow-y-auto">
              {f.steps.map(s => (
                <label key={s.column} className={`flex items-start gap-2.5 px-3 py-2 text-sm ${
                  s.problem ? 'text-gray-400' : 'text-gray-800 hover:bg-gray-50 cursor-pointer'}`}
                data-testid="setup-step-option">
                  <input type="checkbox" className="mt-0.5 border-gray-300 text-cube-black focus:ring-black"
                    checked={f.picked.includes(s.column)} disabled={!!s.problem} onChange={() => f.toggle(s.column)}
                    aria-label={s.column} />
                  <span className="min-w-0">
                    <span className="font-medium">{s.column}</span>
                    <span className="text-xs text-gray-500"> · {SETUP_KIND_LABEL[s.kind]}</span>
                    <span className="block text-xs text-gray-500 truncate">
                      {s.problem ?? (s.reads.length ? `Reads ${s.reads.join(', ')}` : 'Reads no other column')}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          )}
          <p className="text-xs text-gray-500 mt-1">
            Ticking a column also ticks the filled columns it reads, so the whole flow is saved.
          </p>
        </div>

        <SetupPlanView plan={f.plan} picked={f.picked.length} />
      </div>
      <div className="px-6 pb-6 flex justify-end gap-3">
        <button type="button" className="btn-secondary" onClick={onClose} disabled={f.saving}>Cancel</button>
        <button type="button" className="btn-primary" disabled={!f.canSave} onClick={() => void f.save()}
          data-testid="setup-save">
          {f.saving ? 'Saving…' : 'Save setup'}
        </button>
      </div>
    </Modal>
  )
}
