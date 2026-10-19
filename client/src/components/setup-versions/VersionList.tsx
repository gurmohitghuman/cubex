import React, { useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { SetupVersion } from '@/utils/api/setup-versions'

interface Props {
  versions: SetupVersion[] | null
  busy: boolean
  onSave: (name: string) => Promise<boolean>
  onCompare: (v: SetupVersion) => void
  onRename: (v: SetupVersion, name: string) => Promise<boolean>
  onDelete: (v: SetupVersion) => void
  nameRef: React.MutableRefObject<HTMLInputElement | null>
}

const when = (iso: string) => new Date(iso).toLocaleString('en-US',
  { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
const count = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`
// Columns that fill themselves (AI, HTTP API, enrichment, waterfall, clean, formula, lookup).
const fillSelf = (n: number) => (n === 0 ? '' : n === 1 ? ', 1 fills itself'
  : `, ${n.toLocaleString('en-US')} fill themselves`)

// The sheet's versions, newest first, with a box to save the setup as it is now.
export const VersionList: React.FC<Props> = ({ versions, busy, onSave, onCompare, onRename, onDelete, nameRef }) => {
  const [name, setName] = useState('')
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    if (name.trim() && await onSave(name.trim())) setName('')
  }
  const commitRename = async (v: SetupVersion) => {
    if (!renaming) return
    const value = renaming.value.trim()
    if (!value || value === v.name || await onRename(v, value)) setRenaming(null)
  }

  return (
    <div>
      <form onSubmit={save} className="flex flex-wrap items-center gap-2 px-6 py-4 border-b border-gray-200">
        <input className="input flex-1 min-w-[12rem]" value={name} onChange={e => setName(e.target.value)}
          maxLength={100} ref={nameRef} placeholder="Name, for example: Before the new prompt"
          data-testid="setup-version-name" />
        <button type="submit" className="btn-primary whitespace-nowrap" disabled={busy || !name.trim()}
          data-testid="setup-version-save">Save version</button>
      </form>
      {versions === null ? (
        <p className="px-6 py-8 text-sm text-gray-500">Loading…</p>
      ) : versions.length === 0 ? (
        <p className="px-6 py-8 text-sm text-gray-600" data-testid="setup-versions-empty">
          No versions yet. Save one before you change prompts, requests or formulas, so you can put them back.
        </p>
      ) : (
        <ul className="divide-y divide-gray-100 max-h-[55vh] overflow-y-auto" data-testid="setup-versions-list">
          {versions.map(v => (
            <li key={v.id} className="px-6 py-3 flex flex-wrap items-center gap-x-3 gap-y-2"
              data-testid="setup-version-row">
              <div className="min-w-[12rem] flex-1">
                {renaming?.id === v.id ? (
                  <input className="input w-full" value={renaming.value} autoFocus maxLength={100}
                    onChange={e => setRenaming({ id: v.id, value: e.target.value })}
                    data-testid="setup-version-rename-input"
                    onKeyDown={e => {
                      if (e.key === 'Enter') { e.preventDefault(); void commitRename(v) }
                      if (e.key === 'Escape') { e.stopPropagation(); setRenaming(null) }
                    }} />
                ) : (
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-medium text-gray-900 truncate" title={v.name}>{v.name}</span>
                    {v.auto && (
                      <span className="shrink-0 text-[11px] text-gray-600 bg-gray-100 rounded px-1.5 py-0.5"
                        title="Saved automatically before a restore">Automatic</span>
                    )}
                  </div>
                )}
                <p className="text-xs text-gray-500 mt-0.5 truncate">
                  {when(v.saved_at)} · by {v.by} · {count(v.columns, 'column')}{fillSelf(v.filled)}
                </p>
              </div>
              {renaming?.id === v.id ? (
                <div className="flex items-center gap-1 shrink-0">
                  <button type="button" className="btn-primary" disabled={busy} onClick={() => void commitRename(v)}
                    data-testid="setup-version-rename-save">Save</button>
                  <button type="button" className="btn-secondary" onClick={() => setRenaming(null)}>Cancel</button>
                </div>
              ) : deleting === v.id ? (
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs text-gray-700">Delete for good?</span>
                  <button type="button" className="btn-secondary text-red-600" disabled={busy}
                    onClick={() => { setDeleting(null); onDelete(v) }} data-testid="setup-version-delete-yes">
                    Delete
                  </button>
                  <button type="button" className="btn-secondary" onClick={() => setDeleting(null)}>Keep</button>
                </div>
              ) : (
                <div className="flex items-center gap-1 shrink-0">
                  <button type="button" className="btn-secondary" disabled={busy} onClick={() => onCompare(v)}
                    data-testid="setup-version-compare">Compare and restore</button>
                  <button type="button" className="btn-secondary" disabled={busy}
                    onClick={() => setRenaming({ id: v.id, value: v.name })} data-testid="setup-version-rename">
                    Rename
                  </button>
                  <button type="button" className="btn-secondary px-2 text-gray-500 hover:text-red-600" disabled={busy}
                    onClick={() => setDeleting(v.id)} aria-label={`Delete ${v.name}`} title="Delete this version"
                    data-testid="setup-version-delete"><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
