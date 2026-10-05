import React, { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Plus } from 'lucide-react'
import { appendKey, appendIndex, defaultColumnName } from './jsonPath'

// Recursive, dependency-free JSON tree. Each leaf shows its value and a
// "Save as column" affordance; clicking it opens a small inline name input
// that calls onPick(jsonPath, columnName). Containers (objects/arrays) are
// collapsible. Shared by the HTTP API modal and the webhook drawer — one tree,
// one path builder (./jsonPath), so the client emits exactly the dialect the
// server extractor resolves (bracket-quoting keys with dots/spaces/etc.).
//
// `expandSignal` lets the parent force-open or force-close every node — bumping
// the number sets all containers to `forceOpenState`. Used by the "Expand all"
// / "Collapse all" buttons so the user can flip nested fields into view at once.
export function JsonTree({
  value, path, mappingByPath, onPick, depth = 0, expandSignal, forceOpenState,
}: {
  value: any
  path: string
  mappingByPath: Map<string, string>
  onPick: (jsonPath: string, columnName: string) => void
  depth?: number
  expandSignal?: number
  forceOpenState?: boolean
}) {
  if (value === null || value === undefined || typeof value !== 'object') {
    return <Leaf value={value} path={path} mappingByPath={mappingByPath} onPick={onPick} />
  }
  if (Array.isArray(value)) {
    return <ArrayNode arr={value} path={path} mappingByPath={mappingByPath} onPick={onPick} depth={depth} expandSignal={expandSignal} forceOpenState={forceOpenState} />
  }
  return <ObjectNode obj={value as Record<string, unknown>} path={path} mappingByPath={mappingByPath} onPick={onPick} depth={depth} expandSignal={expandSignal} forceOpenState={forceOpenState} />
}

function ObjectNode({
  obj, path, mappingByPath, onPick, depth, expandSignal, forceOpenState,
}: { obj: Record<string, unknown>; path: string; mappingByPath: Map<string, string>; onPick: (p: string, c: string) => void; depth: number; expandSignal?: number; forceOpenState?: boolean }) {
  const [open, setOpen] = useState(depth < 3)
  // When the parent bumps expandSignal, snap to the requested state.
  useEffect(() => {
    if (expandSignal !== undefined && forceOpenState !== undefined) setOpen(forceOpenState)
  }, [expandSignal, forceOpenState])
  const entries = Object.entries(obj)
  if (entries.length === 0) return <span className="text-gray-400">{'{}'}</span>
  return (
    <div>
      <button type="button" onClick={() => setOpen(o => !o)} className="text-gray-500 hover:text-cube-black inline-flex items-center">
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span className="ml-1">{open ? '{' : `{ … ${entries.length} fields }`}</span>
      </button>
      {open && (
        <div className="ml-4">
          {entries.map(([k, v], i) => (
            <div key={k} className="flex items-start gap-2 py-0.5">
              <span className="text-gray-700">"{k}":</span>
              <div className="flex-1 min-w-0">
                <JsonTree value={v} path={appendKey(path, k)} mappingByPath={mappingByPath} onPick={onPick} depth={depth + 1} expandSignal={expandSignal} forceOpenState={forceOpenState} />
                {i < entries.length - 1 && <span className="text-gray-400">,</span>}
              </div>
            </div>
          ))}
          <div className="text-gray-500">{'}'}</div>
        </div>
      )}
    </div>
  )
}

function ArrayNode({
  arr, path, mappingByPath, onPick, depth, expandSignal, forceOpenState,
}: { arr: any[]; path: string; mappingByPath: Map<string, string>; onPick: (p: string, c: string) => void; depth: number; expandSignal?: number; forceOpenState?: boolean }) {
  const [open, setOpen] = useState(depth < 3)
  useEffect(() => {
    if (expandSignal !== undefined && forceOpenState !== undefined) setOpen(forceOpenState)
  }, [expandSignal, forceOpenState])
  if (arr.length === 0) return <span className="text-gray-400">[]</span>
  return (
    <div>
      <button type="button" onClick={() => setOpen(o => !o)} className="text-gray-500 hover:text-cube-black inline-flex items-center">
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span className="ml-1">{open ? '[' : `[ … ${arr.length} items ]`}</span>
      </button>
      {open && (
        <div className="ml-4">
          {arr.map((v, i) => (
            <div key={i} className="flex items-start gap-2 py-0.5">
              <span className="text-gray-500">{i}:</span>
              <div className="flex-1 min-w-0">
                <JsonTree value={v} path={appendIndex(path, i)} mappingByPath={mappingByPath} onPick={onPick} depth={depth + 1} expandSignal={expandSignal} forceOpenState={forceOpenState} />
                {i < arr.length - 1 && <span className="text-gray-400">,</span>}
              </div>
            </div>
          ))}
          <div className="text-gray-500">]</div>
        </div>
      )}
    </div>
  )
}

function Leaf({
  value, path, mappingByPath, onPick,
}: { value: unknown; path: string; mappingByPath: Map<string, string>; onPick: (p: string, c: string) => void }) {
  const existing = mappingByPath.get(path)
  const [naming, setNaming] = useState(false)
  // Default the column name to the last key segment (handles bracket-quoted keys).
  const [name, setName] = useState(() => defaultColumnName(path))

  const display = value === null ? <span className="text-gray-400">null</span>
    : typeof value === 'string' ? <span className="text-green-700">"{truncate(value, 80)}"</span>
    : typeof value === 'boolean' ? <span className="text-blue-700">{String(value)}</span>
    : typeof value === 'number' ? <span className="text-purple-700">{String(value)}</span>
    : <span className="text-gray-600">{String(value)}</span>

  if (existing) {
    return (
      <span className="inline-flex items-center gap-2">
        {display}
        <span className="text-xs bg-cube-black text-white px-1.5 py-0.5">✓ {existing}</span>
      </span>
    )
  }

  if (naming) {
    return (
      <span className="inline-flex items-center gap-1">
        {display}
        <input
          type="text"
          autoFocus
          className="input text-xs px-1 py-0.5 max-w-[140px]"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && name.trim()) { onPick(path, name.trim()); setNaming(false) }
            if (e.key === 'Escape') setNaming(false)
          }}
        />
        <button type="button" onClick={() => { if (name.trim()) { onPick(path, name.trim()); setNaming(false) } }}
          className="text-xs bg-cube-black text-white px-1.5 py-0.5">Save</button>
        <button type="button" onClick={() => setNaming(false)}
          className="text-xs text-gray-500 hover:text-cube-black">Cancel</button>
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-2">
      {display}
      <button type="button" onClick={() => setNaming(true)}
        className="text-xs text-gray-500 hover:text-cube-black inline-flex items-center gap-0.5 opacity-60 hover:opacity-100">
        <Plus className="h-3 w-3" /> Save as column
      </button>
    </span>
  )
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}
