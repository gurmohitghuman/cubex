import React, { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { settingsAPI, type EnrichReuseSetting } from '@/utils/api'
import { plural } from '@/lib/utils'

// "Reuse found answers: 30 days [Change]". A row whose lookup found something
// in that time (any sheet) fills from that answer for free instead of calling
// treg again; 0 turns it off. Reads and saves its own setting.
export const ReuseDaysControl: React.FC = () => {
  const [setting, setSetting] = useState<EnrichReuseSetting | null>(null)
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('30')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    settingsAPI.getEnrichReuse().then(setSetting).catch(() => setSetting(null))
  }, [])
  if (!setting) return null

  const parsed = Number(value)
  const valid = Number.isInteger(parsed) && parsed >= 0 && parsed <= setting.maxDays
  const save = async () => {
    setSaving(true)
    try {
      setSetting(await settingsAPI.setEnrichReuse(parsed))
      setEditing(false)
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Failed to save the setting')
    } finally { setSaving(false) }
  }

  return (
    <div className="border border-gray-200 rounded-sm p-3" data-testid="enrich-reuse-days">
      {!editing ? (
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm text-gray-800">
            <span className="font-medium">Reuse found answers:</span>{' '}
            {setting.days > 0 ? plural(setting.days, 'day') : 'off'}
            <span className="block text-xs text-gray-500 mt-1">
              {setting.days > 0
                ? `A row whose lookup found something in the last ${plural(setting.days, 'day')}, in any sheet, `
                  + 'reuses that answer for free instead of calling treg again. Runs set to Always call again skip it.'
                : 'Every row calls treg, even for a lookup an earlier run already found.'}
            </span>
          </p>
          <button onClick={() => { setValue(String(setting.days)); setEditing(true) }}
            className="btn-secondary text-xs whitespace-nowrap">Change</button>
        </div>
      ) : (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-gray-800">Reuse found answers for</span>
            <input type="number" min="0" max={setting.maxDays} step="1" className="input w-20" value={value}
              onChange={e => setValue(e.target.value)} aria-label="Days to reuse found answers" />
            <span className="text-sm text-gray-800">days</span>
            <button onClick={save} disabled={!valid || saving} className="btn-primary flex items-center gap-1">
              {saving && <Loader2 className="h-3 w-3 animate-spin" />}<span>Save</span>
            </button>
            <button onClick={() => setEditing(false)} className="btn-secondary">Cancel</button>
          </div>
          <p className="text-xs text-gray-500">0 turns it off. At most {setting.maxDays} days.</p>
        </div>
      )}
    </div>
  )
}
