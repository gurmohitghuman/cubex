import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { ChevronDown, ChevronRight } from 'lucide-react'
import {
  childKeys, countLabel, cutText, isContainer, openPaths, pageStarts, pathLabel, visibleText, type Start,
} from './tree-model'
import { TreeContext, useTree, type TreeState } from './tree-context'
import { Leaf, ManualCopy } from './JsonLeaf'
import { Pager } from './JsonPager'
import { pathKey } from './readPath'
import { appendIndex } from './jsonPath'
import {
  JSON_TREE_AUTO_OPEN_DEPTH, JSON_TREE_AUTO_OPEN_ROWS, JSON_TREE_EXPAND_ALL_DEPTH, JSON_TREE_EXPAND_ALL_ROWS,
  JSON_TREE_KEY_PREVIEW, JSON_TREE_PAGE_ITEMS,
} from '@/lib/constants'

// Dependency-free JSON tree, text only. Shared by the answer panel (a cell's
// stored reply), the HTTP API dialog and the webhook drawer: one tree, one path
// builder (./jsonPath), so the client emits exactly the dialect the server
// reads (bracket-quoting keys with dots/spaces/etc.).
//
// Nothing big goes into the page at once: a container shows a page of its
// children (Previous/Next), the tree opens by itself only while few rows show
// (tree-model.ts openPaths), and a long string shows its start ("show more").
// Clicking a key or a value copies its JSONPath; each value can become a column.
//
// `expandSignal` lets the parent open or close every node: bumping the number
// sets the tree to `forceOpenState` ("Expand all" opens as far as a row budget).
type Mode = 'auto' | 'all' | 'none'
const NONE = { open: new Set<string>(), complete: true }
const opened = (starts: Start[], mode: Mode) => mode === 'none' ? NONE : mode === 'all'
  ? openPaths(starts, JSON_TREE_EXPAND_ALL_DEPTH, JSON_TREE_EXPAND_ALL_ROWS, JSON_TREE_PAGE_ITEMS)
  : openPaths(starts, JSON_TREE_AUTO_OPEN_DEPTH, JSON_TREE_AUTO_OPEN_ROWS, JSON_TREE_PAGE_ITEMS)

export function JsonTree({
  value, path, mappingByPath, onPick, expandSignal, forceOpenState, pickLabel = 'Save as column',
}: {
  value: any
  path: string
  mappingByPath: Map<string, string>
  onPick?: (jsonPath: string, columnName: string) => void
  expandSignal?: number
  forceOpenState?: boolean
  // The pick button's words ("Save as column"; the answer panel says "Add as column").
  pickLabel?: string
}) {
  const [mode, setMode] = useState<Mode>('auto')
  // What the person opened or closed by hand (or a later page opened), over the mode's defaults.
  const [toggled, setToggled] = useState<Map<string, boolean>>(() => new Map())
  // Off HTTPS (a plain-HTTP install on the LAN) the browser has no clipboard: the path shows to copy by hand.
  const [manual, setManual] = useState<string | null>(null)
  useEffect(() => {
    if (expandSignal === undefined || forceOpenState === undefined) return
    setMode(forceOpenState ? 'all' : 'none')
    setToggled(new Map())
  }, [expandSignal, forceOpenState])
  const base = useMemo(() => opened([{ v: value, path, depth: 0 }], mode), [value, path, mode])
  const mapped = useMemo(() => new Map([...mappingByPath].map(([p, c]) => [pathKey(p), c])), [mappingByPath])

  const copyPath = useCallback(async (p: string) => {
    try {
      if (!navigator.clipboard) throw new Error('no clipboard')
      await navigator.clipboard.writeText(p)
      setManual(null)
      // One toast: copying another path replaces it instead of stacking up.
      toast.success(`Copied ${pathLabel(p, 80)}`, { id: 'json-tree-copied' })
    } catch {
      setManual(p)
    }
  }, [])
  const state = useMemo<TreeState>(() => ({
    isOpen: p => toggled.get(p) ?? base.open.has(p),
    toggle: p => setToggled(m => new Map(m).set(p, !(m.get(p) ?? base.open.has(p)))),
    openPage: starts => {
      const { open } = opened(starts, mode)
      if (!open.size) return
      setToggled(m => {
        const n = new Map(m)
        for (const p of open) if (!n.has(p)) n.set(p, true)
        return n
      })
    },
    columnFor: p => mapped.get(pathKey(p)),
    onPick, pickLabel, copyPath, manual, closeManual: () => setManual(null),
  }), [toggled, base, mode, mapped, onPick, pickLabel, copyPath, manual])

  return (
    <TreeContext.Provider value={state}>
      {mode === 'all' && !base.complete && (
        <p className="font-sans text-gray-600 mb-1" data-testid="json-tree-partial">
          Expand all opened what fits ({JSON_TREE_EXPAND_ALL_ROWS.toLocaleString('en-US')} rows,{' '}
          {JSON_TREE_EXPAND_ALL_DEPTH} levels). Open the rest by hand.
        </p>
      )}
      <Node value={value} path={path} label={null} depth={0} />
    </TreeContext.Provider>
  )
}

// `label`: the key (or index) in front of the value, null at the root.
function Node({ value, path, label, depth }: { value: unknown; path: string; label: React.ReactNode; depth: number }) {
  return isContainer(value) ? <ContainerNode value={value} path={path} label={label} depth={depth} />
    : <Leaf value={value} path={path} label={label} />
}

// A container's line (its key, then a toggle with its count), then its children
// a page at a time, each indented one step under it.
function ContainerNode({ value, path, label, depth }: {
  value: unknown[] | Record<string, unknown>; path: string; label: React.ReactNode; depth: number
}) {
  const t = useTree()
  const keys = useMemo(() => childKeys(value), [value])
  const [pageStart, setPageStart] = useState(0)
  // The item "Go to item" went to: shown and marked (seq: each go scrolls again).
  const [target, setTarget] = useState<{ path: string; seq: number } | null>(null)
  const array = keys === null
  const total = keys ? keys.length : (value as unknown[]).length
  const open = t.isOpen(path)
  const [o, c] = array ? ['[', ']'] : ['{', '}']
  const count = countLabel(total, array)
  const start = pageStart < total ? pageStart : 0
  const end = Math.min(total, start + JSON_TREE_PAGE_ITEMS)
  const go = (s: number) => {
    setPageStart(s)
    if (s > 0) t.openPage(pageStarts(value, path, depth + 1, s, JSON_TREE_PAGE_ITEMS))
  }
  const goTo = (n: number) => {
    go(Math.floor(n / JSON_TREE_PAGE_ITEMS) * JSON_TREE_PAGE_ITEMS)
    setTarget(x => ({ path: appendIndex(path, n), seq: (x?.seq ?? 0) + 1 }))
  }
  const rows = open ? pageStarts(value, path, depth + 1, start, JSON_TREE_PAGE_ITEMS).map((s, n) => (
    <RowBox key={s.path} path={s.path} focus={target?.path === s.path ? target.seq : 0}>
      <Node value={s.v} path={s.path} depth={s.depth}
        label={<KeyLabel name={keys ? keys[start + n] : null} index={start + n} path={s.path} />} />
    </RowBox>
  )) : null
  const paged = total > JSON_TREE_PAGE_ITEMS
  return (
    <div>
      <div className="flex items-start gap-2 py-0.5 min-w-0">
        {label}
        {total === 0 ? <span className="text-gray-400">{array ? '[]' : '{}'}</span> : (
          <button type="button" onClick={() => t.toggle(path)} aria-expanded={open} data-testid="json-toggle"
            className="text-gray-500 hover:text-cube-black inline-flex items-center whitespace-nowrap">
            {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <span className="ml-1">{open ? `${o} ${count}` : `${o} … ${count} ${c}`}</span>
          </button>
        )}
      </div>
      {t.manual === path && <ManualCopy path={path} />}
      {open && total > 0 && (
        <>
          <div className="ml-4">
            {paged && <Pager array={array} start={start} end={end} total={total} onGo={go} onGoTo={goTo} />}
            {rows}
            {paged && <Pager array={array} start={start} end={end} total={total} onGo={go} onGoTo={goTo} />}
          </div>
          <div className="text-gray-500">{c}</div>
        </>
      )}
    </div>
  )
}

// A child's row; the one "Go to item" picked scrolls into view, marked.
function RowBox({ path, focus, children }: { path: string; focus: number; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { if (focus) ref.current?.scrollIntoView({ block: 'center' }) }, [focus])
  return <div ref={ref} data-json-row={path} className={focus ? 'bg-amber-50' : undefined}>{children}</div>
}

// A child's key (or array index): clicking it copies the child's path. A long
// key is cut, keeping its closing quote and colon in view.
function KeyLabel({ name, index, path }: { name: string | null; index: number; path: string }) {
  const t = useTree()
  const key = name === null ? null : cutText(name, JSON_TREE_KEY_PREVIEW)
  return (
    <button type="button" onClick={() => t.copyPath(path)} title={`Copy the path ${pathLabel(path)}`}
      className="shrink-0 max-w-[40%] min-w-0 inline-flex text-left hover:bg-gray-100" data-testid="json-key">
      {key === null ? <span className="text-gray-500">{index}:</span> : (
        <>
          <span className="text-gray-700 truncate min-w-0">
            "<bdi>{visibleText(key.text)}</bdi>{key.rest > 0 && '…'}
          </span>
          <span className="text-gray-700 shrink-0">":</span>
        </>
      )}
    </button>
  )
}
