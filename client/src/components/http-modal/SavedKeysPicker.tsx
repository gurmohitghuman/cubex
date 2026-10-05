import React, { useEffect, useState } from 'react'
import { Eye, EyeOff, Key, Plus } from 'lucide-react'
import toast from 'react-hot-toast'
import { settingsAPI } from '@/utils/api'
import type { APIKey } from '@/utils/api/types'

interface Props {
  // Currently selected saved-key name (the user picks from existing keys) OR
  // empty string when they're entering a new one inline.
  selectedKeyName: string
  setSelectedKeyName: (name: string) => void
  // Inline new-key entry. Caller decides what to do with it (e.g. save on
  // submit, or include it in a request without saving). For Phase 1 we always
  // save inline when the user checks "Save for next time."
  inlineKey: string
  setInlineKey: (key: string) => void
  saveInline: boolean
  setSaveInline: (b: boolean) => void
  inlineKeyName: string
  setInlineKeyName: (name: string) => void
}

// Kid-friendly credentials picker. Reuses the existing api_keys table via
// settingsAPI — no new server work. The user can EITHER pick a saved key
// from the dropdown OR type a key inline (and optionally save it for next
// time). Keeps the surface area low: one row of UI for the 90% case where
// the user has one Apollo / Clearbit key and reuses it across many columns.
export const SavedKeysPicker: React.FC<Props> = ({
  selectedKeyName, setSelectedKeyName,
  inlineKey, setInlineKey,
  saveInline, setSaveInline,
  inlineKeyName, setInlineKeyName,
}) => {
  const [keys, setKeys] = useState<APIKey[]>([])
  const [showKey, setShowKey] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setLoading(true)
    settingsAPI.getAPIKeys()
      .then(setKeys)
      .catch(() => { /* silent — the user can still enter a key inline */ })
      .finally(() => setLoading(false))
  }, [])

  const handleSaveInline = async () => {
    const name = inlineKeyName.trim()
    if (!name || !inlineKey.trim()) {
      toast.error('Pick a name and paste the key first.')
      return
    }
    try {
      const created = await settingsAPI.createAPIKey({ name, key_type: 'bearer', key_value: inlineKey.trim() })
      setKeys(prev => [...prev, created])
      setSelectedKeyName(created.name)
      setInlineKey('')
      setInlineKeyName('')
      setSaveInline(false)
      toast.success(`Saved "${created.name}" for next time`)
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'Could not save the key')
    }
  }

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-gray-700">Got an API key from that tool? <span className="text-gray-400 font-normal">(optional)</span></label>

      {keys.length > 0 && (
        <select
          className="input w-full"
          value={selectedKeyName}
          onChange={(e) => setSelectedKeyName(e.target.value)}
        >
          <option value="">Pick a saved key or paste one below</option>
          {keys.map(k => (
            <option key={k.id} value={k.name}>{k.name}</option>
          ))}
        </select>
      )}

      {!selectedKeyName && (
        <div className="space-y-2">
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              className="input w-full pr-10"
              placeholder={loading ? 'Loading…' : 'Paste your API key here'}
              value={inlineKey}
              onChange={(e) => setInlineKey(e.target.value)}
            />
            <button
              type="button"
              onClick={() => setShowKey(s => !s)}
              className="absolute right-2 top-2.5 text-gray-400 hover:text-gray-700"
              aria-label={showKey ? 'Hide key' : 'Show key'}
            >
              {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>

          {inlineKey.trim() && (
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={saveInline}
                onChange={(e) => setSaveInline(e.target.checked)}
                className="border-gray-300"
              />
              <span>Save for next time as</span>
              <input
                type="text"
                className="input flex-1 max-w-xs"
                placeholder="e.g. Apollo"
                value={inlineKeyName}
                onChange={(e) => setInlineKeyName(e.target.value)}
                disabled={!saveInline}
              />
              {saveInline && (
                <button type="button" onClick={handleSaveInline}
                  className="text-xs text-cube-black hover:text-gray-700 flex items-center gap-1 px-2 py-1 bg-gray-100 hover:bg-gray-200">
                  <Plus className="h-3 w-3" /> Save
                </button>
              )}
            </label>
          )}
        </div>
      )}

      {selectedKeyName && (
        <p className="text-xs text-gray-500 flex items-center gap-1">
          <Key className="h-3 w-3" />
          Using saved key: <span className="font-medium text-gray-700">{selectedKeyName}</span>
          <button type="button" onClick={() => setSelectedKeyName('')} className="ml-2 underline">Use a different key</button>
        </p>
      )}
    </div>
  )
}
