import React, { useState } from 'react'
import toast from 'react-hot-toast'
import { aiVisibilityAPI, type AiVisibilityView } from '@/utils/api/ai-visibility'
import { linesOf } from '@/lib/ai-visibility'

// The brands the table's formulas look for (yours first). Saving rewrites
// them and works every row out again from the answers there: free, nothing
// is asked again.
export const BrandsEditor: React.FC<{ v: AiVisibilityView; onSaved: () => void }> = ({ v, onSaved }) => {
  const [editing, setEditing] = useState(false)
  const [brand, setBrand] = useState(v.brand)
  const [others, setOthers] = useState(v.competitors.join('\n'))
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    try {
      // One per line, as shown: a brand with a comma in it ("Acme, Inc.") stays whole.
      const r = await aiVisibilityAPI.setBrands(v.id, brand.trim(), linesOf(others))
      if (r.problems.length) toast.error(r.problems[0])
      else toast.success('Saved. The columns read the answers again.')
      setEditing(false)
      onSaved()
    } catch (err: any) {
      toast.error(err?.response?.data?.error || "Couldn't save the brands.")
    } finally { setBusy(false) }
  }

  if (!editing) {
    return (
      <p className="text-xs text-gray-600" data-testid="ai-visibility-brands">
        Looks for <b>{v.brand}</b> (you){v.competitors.length ? `, ${v.competitors.join(', ')}` : ''}.{' '}
        <button type="button" className="underline" onClick={() => setEditing(true)}>Edit brands</button>
      </p>
    )
  }
  return (
    <div className="space-y-2 text-xs">
      <input className="input w-full" value={brand} onChange={e => setBrand(e.target.value)} aria-label="Your brand" />
      <textarea className="input w-full h-16" value={others} onChange={e => setOthers(e.target.value)}
        aria-label="Other brands to look for" placeholder="Other brands, one per line" />
      <div className="flex gap-2">
        <button type="button" className="btn-primary text-xs px-3 py-1 disabled:opacity-50"
          disabled={busy || !brand.trim()} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="btn-secondary text-xs px-3 py-1" onClick={() => setEditing(false)}>
          Cancel</button>
      </div>
    </div>
  )
}
