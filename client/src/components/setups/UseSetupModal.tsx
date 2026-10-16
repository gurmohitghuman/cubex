import React from 'react'
import Modal from '@/components/Modal'
import { SETUP_KIND_LABEL } from '@/utils/api/setups'
import { useUseSetupForm } from './useUseSetupForm'
import { SetupFitForm } from './SetupFitForm'
import { SetupEstimateView } from './SetupEstimateView'

interface Props {
  isOpen: boolean
  onClose: () => void
  sheetId: string
  columns: string[]
}

// Use a setup: pick a saved one, match what it reads to this sheet's columns,
// see what it would cost, start. Its columns are made and filled step by step,
// each once the columns it reads are filled.
export const UseSetupModal: React.FC<Props> = ({ isOpen, onClose, sheetId, columns }) => {
  const f = useUseSetupForm({ sheetId, columns, open: isOpen, onStarted: onClose })
  return (
    <Modal isOpen={isOpen} onClose={() => { if (!f.starting) onClose() }} panelClassName="max-w-2xl w-full">
      <div className="p-6 border-b border-gray-200">
        <h3 className="text-title text-gray-900">{f.setup ? `Use "${f.setup.name}"` : 'Use a setup'}</h3>
        <p className="text-sm text-gray-600 mt-1">
          Builds a saved setup&apos;s columns on this sheet and fills them in order, each once the columns it reads
          are filled.
        </p>
      </div>
      <div className="p-6 space-y-5 max-h-[65vh] overflow-y-auto" data-testid="use-setup-form">
        {f.loadError ? (
          <p className="text-sm text-red-600">{f.loadError}</p>
        ) : !f.setups ? (
          <p className="text-sm text-gray-500">Loading your setups…</p>
        ) : f.setups.length === 0 ? (
          <p className="text-sm text-gray-600">
            No setups yet. Save one from a sheet with filled columns: choose Setups, then Save columns as a setup.
          </p>
        ) : !f.setup ? (
          <div className="border border-gray-200 divide-y divide-gray-100">
            {f.setups.map(s => (
              <button key={s.id} type="button" onClick={() => void f.pick(s.id)} data-testid="use-setup-option"
                className="w-full text-left px-4 py-3 hover:bg-gray-50">
                <span className="font-medium text-gray-900">{s.name}</span>
                {s.description && <span className="block text-sm text-gray-500">{s.description}</span>}
                <span className="block text-xs text-gray-500 mt-1">
                  {s.steps.map(st => `${st.column} (${SETUP_KIND_LABEL[st.kind]})`).join(' → ')}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <>
            <button type="button" className="text-xs text-gray-700 underline" onClick={() => void f.pick(null)}>
              Pick another setup
            </button>
            <SetupFitForm form={f} columns={columns} />
            <SetupEstimateView state={f.estimate} />
          </>
        )}
      </div>
      <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
        <button type="button" className="btn-secondary" onClick={onClose} disabled={f.starting}>Cancel</button>
        {f.setup && (
          <button type="button" className="btn-primary" disabled={!f.canStart} onClick={() => void f.start()}
            data-testid="use-setup-start">
            {f.starting ? 'Starting…' : f.test.on ? `Test on ${f.test.rows} rows` : 'Start'}
          </button>
        )}
      </div>
    </Modal>
  )
}
