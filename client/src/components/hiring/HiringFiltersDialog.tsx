import React, { useState } from 'react'
import toast from 'react-hot-toast'
import { Modal } from '@/components/Modal'
import { hiringAPI, type HiringView } from '@/utils/api/hiring'
import { HIRING_MAX_MIN_ROLES } from '@/lib/hiring'

// A hiring table's filters on Companies, changed after create (PATCH /api/hiring/:id): the same two fields as the
// create dialog's "On Companies". They apply from the next check: a company kept off before gets its row then if
// it passes now, and a row already on Companies stays. The server's refusal (a check going, a company that is also
// one of "only these companies") shows as it says it.
export const HiringFiltersDialog: React.FC<{ v: HiringView; onClose: () => void; onSaved: () => void }> =
  ({ v, onClose, onSaved }) => {
    const [minRoles, setMinRoles] = useState(String(v.minRoles))
    const [leaveOut, setLeaveOut] = useState(v.leaveOutCompanies.join(', '))
    const [busy, setBusy] = useState(false)
    const min = minRoles.trim() === '' ? 1 : Number(minRoles)
    const badMin = !Number.isInteger(min) || min < 1 || min > HIRING_MAX_MIN_ROLES

    const save = async () => {
      setBusy(true)
      try {
        await hiringAPI.setFilters(v.id, { minRoles: min, leaveOutCompanies: leaveOut })
        toast.success('Saved: the next check sums up Companies by these filters.')
        onSaved()
        onClose()
      } catch (err: any) {
        toast.error(err?.response?.data?.error || "Couldn't save the filters.")
        setBusy(false)
      }
    }

    return (
      <Modal isOpen onClose={() => { if (!busy) onClose() }} panelClassName="max-w-md w-full">
        <div className="p-6 space-y-3" data-testid="hiring-filters-dialog">
          <h3 className="text-title text-gray-900">Filters on Companies</h3>
          <label className="flex flex-wrap items-center gap-2 text-sm font-medium text-gray-900">
            Companies with at least
            <input className="input w-20" type="number" min={1} max={HIRING_MAX_MIN_ROLES} value={minRoles}
              onChange={e => setMinRoles(e.target.value)} aria-label="Companies with at least N matching roles" />
            matching roles
          </label>
          {badMin && <p className="text-xs text-red-600">A whole number from 1 to {HIRING_MAX_MIN_ROLES}.</p>}
          <div>
            <div className="text-sm font-medium text-gray-900 mb-1">Leave these companies out of Companies</div>
            <textarea className="input w-full h-16" value={leaveOut} onChange={e => setLeaveOut(e.target.value)}
              placeholder="acme.com, ramp.com" aria-label="Leave these companies out of Companies" />
            <p className="text-xs text-gray-500 mt-1">Websites, commas or lines between them.</p>
          </div>
          <p className="text-xs text-gray-500">
            From the next check: a company these filters kept off gets its row then if it passes now, and a row
            already on Companies stays. Every role is still searched and paid for, and stays in Roles.
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" className="btn-secondary disabled:opacity-50" disabled={busy}
              onClick={onClose}>Cancel</button>
            <button type="button" className="btn-primary disabled:opacity-50" disabled={busy || badMin}
              onClick={() => void save()} data-testid="hiring-filters-save">{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      </Modal>
    )
  }
