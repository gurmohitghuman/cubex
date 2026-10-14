import React from 'react'
import { Loader2, Terminal, X } from 'lucide-react'
import { CurlKeysPanel } from './CurlKeysPanel'
import type { useCurlImport } from './useCurlImport'

type CurlImport = ReturnType<typeof useCurlImport>

const PLACEHOLDER = "curl https://api.example.com/v1/people?email=you@example.com \\\n  -H 'Authorization: Bearer ...'"

// "Paste a cURL command": a link above the request sections that opens a box
// for the command, then the keys panel when the command holds keys, then a
// short list of what was changed or left out once the form is filled.
export const CurlPasteBox: React.FC<{ c: CurlImport }> = ({ c }) => {
  if (!c.open) {
    return (
      <div className="space-y-2">
        <button type="button" onClick={c.start} data-testid="curl-paste-open"
          className="flex items-center gap-2 text-sm text-cube-black hover:text-gray-700">
          <Terminal className="h-4 w-4" />Paste a cURL command
        </button>
        {c.notes.length > 0 && <CurlNotes notes={c.notes} onDismiss={c.dismissNotes} />}
      </div>
    )
  }
  return (
    <div className="border border-gray-200 rounded p-3 space-y-3" data-testid="curl-paste-box">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-sm font-medium text-gray-700">
          <Terminal className="h-4 w-4" />Paste a cURL command
        </span>
        <button type="button" onClick={c.close} aria-label="Close" className="text-gray-400 hover:text-gray-700">
          <X className="h-4 w-4" />
        </button>
      </div>
      {c.keys ? <CurlKeysPanel c={c} /> : (
        <>
          <textarea value={c.text} onChange={e => c.setText(e.target.value)} autoFocus spellCheck={false}
            data-testid="curl-paste-input" aria-label="cURL command"
            className="input w-full h-28 resize-y font-mono text-xs"
            placeholder={PLACEHOLDER} />
          <p className="text-xs text-gray-500">
            Copy it from the API&apos;s docs, or from your browser (right-click a request in DevTools, then
            Copy as cURL). It fills in the method, URL, query, headers and body. Keys it finds become saved
            keys, never part of the column.
          </p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={c.close} className="btn-secondary">Cancel</button>
            <button type="button" onClick={c.submit} disabled={c.busy || !c.text.trim()}
              data-testid="curl-paste-submit" className="btn-primary flex items-center gap-2">
              {c.busy && <Loader2 className="h-4 w-4 animate-spin" />}Fill in
            </button>
          </div>
        </>
      )}
      {c.error && (
        <p className="text-sm text-cube-black bg-gray-100 p-2" role="alert" data-testid="curl-paste-error">{c.error}</p>
      )}
    </div>
  )
}

function CurlNotes({ notes, onDismiss }: { notes: string[]; onDismiss: () => void }) {
  return (
    <div className="bg-gray-50 border border-gray-200 rounded p-2 text-xs text-gray-600" data-testid="curl-paste-notes">
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium text-gray-700">From your cURL command</span>
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className="text-gray-400 hover:text-gray-700">
          <X className="h-3 w-3" />
        </button>
      </div>
      <ul className="list-disc pl-4 mt-1 space-y-0.5">
        {notes.map(n => <li key={n}>{n}</li>)}
      </ul>
    </div>
  )
}
