import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { trashAPI } from '@/utils/api'
import { plural } from '@/lib/utils'

// Settings → Account → Trash: how many days deleted rows, sheets and tables
// stay in the trash before they're deleted for good (0: at once). Lowering it
// deletes what is now older, so that asks first.
export const TrashCard: React.FC = () => {
  const [setting, setSetting] = useState<{ days: number; maxDays: number } | null>(null)
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('30')
  const [saving, setSaving] = useState(false)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => { trashAPI.getDays().then(setSetting).catch(() => setSetting(null)) }, [])
  if (!setting) return null

  const parsed = Number(value)
  const valid = Number.isInteger(parsed) && parsed >= 0 && parsed <= setting.maxDays
  const save = async () => {
    setConfirming(false)
    setSaving(true)
    try {
      setSetting(await trashAPI.setDays(parsed))
      setEditing(false)
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Failed to save the setting')
    } finally { setSaving(false) }
  }

  return (
    <div className="card mb-6" data-testid="trash-days">
      <div className="p-6">
        <h3 className="text-title text-gray-900 mb-1">Trash</h3>
        <p className="text-sm text-gray-500 mb-4">
          Deleted rows, sheets and tables go to the <Link to="/trash" className="underline">trash</Link>, where
          you can restore them. They keep using disk space until they leave it.
        </p>
        {!editing ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-gray-800">
              <span className="font-medium">Keep deleted items:</span>{' '}
              {setting.days > 0 ? plural(setting.days, 'day') : 'no, delete them at once'}
            </p>
            <button onClick={() => { setValue(String(setting.days)); setEditing(true) }}
              className="btn-secondary text-xs whitespace-nowrap">Change</button>
          </div>
        ) : (
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-gray-800">Keep deleted items for</span>
              <input type="number" min="0" max={setting.maxDays} step="1" className="input w-20" value={value}
                onChange={e => setValue(e.target.value)} aria-label="Days to keep deleted items" />
              <span className="text-sm text-gray-800">days</span>
              <button onClick={() => (parsed < setting.days ? setConfirming(true) : void save())}
                disabled={!valid || saving} className="btn-primary flex items-center gap-1">
                {saving && <Loader2 className="h-3 w-3 animate-spin" />}<span>Save</span>
              </button>
              <button onClick={() => setEditing(false)} className="btn-secondary">Cancel</button>
            </div>
            <p className="text-xs text-gray-500">0 deletes them at once. At most {setting.maxDays} days.</p>
          </div>
        )}
      </div>
      <ConfirmDialog isOpen={confirming} isDestructive title="Keep deleted items less long"
        message={parsed === 0
          ? 'Everything in the trash now is deleted, and later deletes skip the trash. Go on?'
          : `Items in the trash for more than ${plural(parsed, 'day')} are deleted now. Go on?`}
        confirmText="Save" onConfirm={() => void save()} onCancel={() => setConfirming(false)} />
    </div>
  )
}
