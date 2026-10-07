import React, { useState } from 'react'
import { Loader2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { EnrichDailyLimit, settingsAPI } from '@/utils/api'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { resetsAtText, spent, usd } from '@/lib/enrich-format'

interface Props {
  limit: EnrichDailyLimit
  onChanged: () => Promise<void>
}

// "Daily limit: $10.00 for all enrichments · $3.20 used today · resets at
// midnight UTC (8:00 pm your time) [Change]". On by default: the owner should
// always see it, and turning it off takes a confirmation.
export const DailyLimitControl: React.FC<Props> = ({ limit, onChanged }) => {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(limit.limitUsd !== null ? String(limit.limitUsd) : '10')
  const [saving, setSaving] = useState(false)
  const [confirmOff, setConfirmOff] = useState(false)

  const save = async (next: number | null) => {
    setSaving(true)
    try {
      await settingsAPI.setEnrichDailyLimit(next)
      await onChanged()
      setEditing(false)
      setConfirmOff(false)
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Failed to save the daily limit')
    } finally { setSaving(false) }
  }

  const parsed = Number(value)
  const valid = Number.isFinite(parsed) && parsed >= 0.01

  return (
    <div className="border border-gray-200 rounded-sm p-3" data-testid="enrich-daily-limit">
      {!editing ? (
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm text-gray-800">
            <span className="font-medium">Daily limit:</span>{' '}
            {limit.limitUsd !== null ? `${usd(limit.limitUsd)} for all enrichments` : 'off'}
            {' · '}{spent(limit.usedTodayUsd)} used today
            {limit.limitUsd !== null && <> · {resetsAtText()}</>}
            <span className="block text-xs text-gray-500 mt-1">
              Runs and auto-runs pause when today's spending reaches it. It covers runs you start, auto-runs and agents.
            </span>
          </p>
          <button onClick={() => setEditing(true)} className="btn-secondary text-xs whitespace-nowrap">Change</button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-gray-800">Daily limit $</span>
          <input
            type="number" min="0.01" step="0.01" className="input w-28" value={value}
            onChange={e => setValue(e.target.value)} aria-label="Daily limit in dollars"
          />
          <button onClick={() => save(parsed)} disabled={!valid || saving} className="btn-primary flex items-center gap-1">
            {saving && <Loader2 className="h-3 w-3 animate-spin" />}<span>Save</span>
          </button>
          <button onClick={() => setEditing(false)} className="btn-secondary">Cancel</button>
          {limit.limitUsd !== null && (
            <button onClick={() => setConfirmOff(true)} className="text-xs text-gray-600 underline hover:no-underline ml-auto">
              Turn off the limit
            </button>
          )}
        </div>
      )}
      <ConfirmDialog
        isOpen={confirmOff}
        title="Turn off the daily limit?"
        message="Without it, enrichments, auto-runs and agents can spend your whole treg balance in a day. Per-run limits still apply."
        confirmText="Turn off"
        isDestructive
        isLoading={saving}
        onConfirm={() => save(null)}
        onCancel={() => setConfirmOff(false)}
      />
    </div>
  )
}
