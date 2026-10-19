import React, { useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import { canMapPath, cutText, pathLabel, suggestedName, visibleText } from './tree-model'
import { useTree } from './tree-context'
import { JSON_PATH_MAX_CHARS, JSON_TREE_STRING_PREVIEW, JSON_TREE_STRING_STEP } from '@/lib/constants'

// One value of the tree, after its key (`label`). Clicking it copies its
// JSONPath. A long string shows its start and "show more" adds a step at a time
// (a reply can hold a 1 MB string). The pick button names a column filled from
// this path, on a line of its own; a value already mapped shows its column.
export function Leaf({ value, path, label }: { value: unknown; path: string; label: React.ReactNode }) {
  const t = useTree()
  const existing = t.columnFor(path)
  const [naming, setNaming] = useState(false)
  // Default the column name to the last key segment (handles bracket-quoted keys).
  const [name, setName] = useState(() => suggestedName(path))
  const [shown, setShown] = useState(JSON_TREE_STRING_PREVIEW)
  const cut = typeof value === 'string' ? cutText(value, shown) : null
  // Kept between renders: a toggle anywhere redraws the tree, and a long string is slow to scan.
  const text = useMemo(() => (cut ? visibleText(cut.text) : ''), [cut?.text])

  const display = value === null ? <span className="text-gray-400">null</span>
    : cut ? <span className="text-green-700">"<bdi>{text}</bdi>{cut.rest > 0 && '…'}"</span>
    : typeof value === 'boolean' ? <span className="text-blue-700">{String(value)}</span>
    : typeof value === 'number' ? <span className="text-purple-700">{String(value)}</span>
    : <span className="text-gray-600">{String(value)}</span>
  const save = () => { if (name.trim()) { t.onPick?.(path, name.trim()); setNaming(false) } }

  return (
    <div className="flex items-start gap-2 py-0.5 min-w-0">
      {label}
      <div className="flex-1 min-w-0" data-json-path={path}>
        <div className="flex items-start gap-2">
          {/* At least 12 characters wide however deep: past that the tree's box scrolls sideways. */}
          <div className="flex-1 min-w-[12ch] [overflow-wrap:anywhere]">
            <button type="button" onClick={() => t.copyPath(path)} title={`Copy the path ${pathLabel(path)}`}
              className="text-left hover:bg-gray-100" data-testid="json-value">
              {display}
            </button>
            {cut && cut.rest > 0 && (
              <button type="button" onClick={() => setShown(s => s + JSON_TREE_STRING_STEP)}
                className="ml-2 text-gray-500 hover:text-cube-black underline" data-testid="json-show-more">
                show more ({cut.rest.toLocaleString('en-US')} characters left)
              </button>
            )}
            {cut && shown > JSON_TREE_STRING_PREVIEW && (
              <button type="button" onClick={() => setShown(JSON_TREE_STRING_PREVIEW)}
                className="ml-2 text-gray-500 hover:text-cube-black underline">show less</button>
            )}
          </div>
          {existing ? (
            <span className="shrink-0 text-xs leading-4 bg-cube-black text-white px-1.5 max-w-[40%] truncate"
              title={existing}>✓ {existing}</span>
          ) : !naming && t.onPick && !canMapPath(path) ? (
            <span className="shrink-0 whitespace-nowrap text-xs text-gray-400"
              title={`Its path is over ${JSON_PATH_MAX_CHARS} characters, so it can't become a column.`}>
              path too long to add
            </span>
          ) : !naming && t.onPick ? (
            <button type="button" onClick={() => setNaming(true)}
              className={'shrink-0 whitespace-nowrap text-xs text-gray-500 hover:text-cube-black inline-flex '
                + 'items-center gap-0.5 opacity-60 hover:opacity-100'}>
              <Plus className="h-3 w-3" /> {t.pickLabel}
            </button>
          ) : null}
        </div>
        {naming && !existing && (
          <div className="flex items-center gap-1 mt-1">
            <input type="text" autoFocus className="input flex-1 min-w-0 text-xs px-1 py-0.5" value={name}
              onChange={(e) => setName(e.target.value)} aria-label="Column name"
              onKeyDown={(e) => {
                // Handled here: a dialog around the tree must not also close on them.
                if (e.key !== 'Enter' && e.key !== 'Escape') return
                e.preventDefault(); e.stopPropagation()
                if (e.key === 'Escape') setNaming(false)
                else save()
              }} />
            <button type="button" onClick={save}
              className="text-xs bg-cube-black text-white px-1.5 py-0.5">Save</button>
            <button type="button" onClick={() => setNaming(false)}
              className="text-xs text-gray-500 hover:text-cube-black">Cancel</button>
          </div>
        )}
        {t.manual === path && <ManualCopy path={path} />}
      </div>
    </div>
  )
}

// The path to copy by hand, under the line it was clicked on.
export function ManualCopy({ path }: { path: string }) {
  const t = useTree()
  return (
    <div className="border border-gray-200 bg-white p-2 my-1 font-sans" data-testid="json-path-manual">
      <p className="text-xs text-gray-600 mb-1">This browser can&apos;t copy here. Select the path and copy it.</p>
      <div className="flex items-center gap-2">
        <input readOnly autoFocus className="input flex-1 min-w-0 text-xs font-mono" value={path}
          onFocus={e => e.currentTarget.select()} aria-label="JSONPath"
          onKeyDown={e => {
            // Escape closes this box, not the drawer or dialog around the tree.
            if (e.key !== 'Escape') return
            e.preventDefault(); e.stopPropagation()
            t.closeManual()
          }} />
        <button type="button" className="text-xs text-gray-600 hover:text-cube-black"
          onClick={t.closeManual}>Done</button>
      </div>
    </div>
  )
}
