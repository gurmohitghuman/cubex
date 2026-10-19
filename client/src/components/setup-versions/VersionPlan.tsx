import React, { useState } from 'react'
import type { ColumnKind, FieldChange, PlannedColumn, RestoreAnswer } from '@/utils/api/setup-versions'

// A version against the sheet now (what restoring it would do), or what a
// restore did: columns added back, set up as in the version (setting by
// setting, the changed words marked), left as they are with why, and the ones
// the version doesn't have.
const KIND: Record<ColumnKind, string> = {
  plain: 'Plain', made: 'Filled by another column', ai: 'AI', http: 'HTTP API', enrichment: 'Enrichment',
  waterfall: 'Waterfall', clean: 'Clean data', formula: 'Formula', lookup: 'Lookup',
}
// Settings that are code or a request: monospace. Prose (prompts, descriptions) reads better in the app's font.
const CODE = new Set(['Formula', 'URL', 'Body', 'Fields', 'Options', 'Only run if', 'Inputs'])
const LONG = 280
const CONTEXT = 80

// The part of `a` that differs from `b`, at word edges: [before, changed, after].
function changedPart(a: string, b: string): [string, string, string] {
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  while (p > 0 && /\S/.test(a[p - 1])) p--
  let s = 0
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  while (s > 0 && /\S/.test(a[a.length - s])) s--
  return [a.slice(0, p), a.slice(p, a.length - s), a.slice(a.length - s)]
}

const Value: React.FC<{ text: string | null; other: string | null; code: boolean }> = ({ text, other, code }) => {
  const [all, setAll] = useState(false)
  if (text === null) return <span className="text-gray-400">none</span>
  const [before, changed, after] = other === null ? ['', text, ''] : changedPart(text, other)
  const long = text.length > LONG && !all
  // Cut at word edges: the words around the change, not halves of them.
  const head = long && before.length > CONTEXT ? `…${before.slice(-CONTEXT).replace(/^\S*\s/, '')}` : before
  const mid = long && changed.length > LONG ? `${changed.slice(0, LONG)}…` : changed
  const tail = long && after.length > CONTEXT ? `${after.slice(0, CONTEXT).replace(/\s\S*$/, '')}…` : after
  return (
    <span className={`whitespace-pre-wrap break-words ${code ? 'font-mono text-[11px]' : 'text-xs'}`}>
      {head}
      {mid && <mark className="bg-amber-100 text-inherit rounded-sm">{mid}</mark>}
      {tail}
      {text.length > LONG && (
        <button type="button" className="ml-1 text-xs text-gray-500 underline hover:text-gray-800 font-sans"
          onClick={() => setAll(!all)}>{all ? 'Show less' : 'Show all'}</button>
      )}
    </span>
  )
}

const Row: React.FC<{ f: FieldChange }> = ({ f }) => {
  const code = CODE.has(f.field)
  return (
    <tr className="border-t border-gray-100">
      <td className="py-1 pr-2 text-gray-700">{f.field}</td>
      <td className="py-1 pr-2"><Value text={f.version} other={f.now} code={code} /></td>
      <td className="py-1"><Value text={f.now} other={f.version} code={code} /></td>
    </tr>
  )
}

const Badge: React.FC<{ c: PlannedColumn }> = ({ c }) => {
  const words = c.nowKind && c.nowKind !== c.kind
    ? `${KIND[c.kind]} in the version, ${KIND[c.nowKind].toLowerCase()} now`
    : c.kind === 'plain' ? null : KIND[c.kind]
  return words ? <span className="shrink-0 text-[11px] text-gray-600 bg-gray-100 rounded px-1.5 py-0.5">{words}</span>
    : null
}

const Column: React.FC<{ c: PlannedColumn; done: boolean }> = ({ c, done }) => (
  <li className="py-2" data-testid="setup-version-column">
    <div className="flex items-center gap-2 min-w-0">
      <span className="text-sm font-medium text-gray-900 truncate" title={c.column}>{c.column}</span>
      <Badge c={c} />
    </div>
    {c.fields.length > 0 && (
      <table className="mt-1.5 w-full table-fixed text-xs">
        <thead>
          <tr className="text-left text-gray-500">
            <th className="w-36 font-normal pb-0.5">Setting</th>
            <th className="font-normal pb-0.5">{done ? 'Restored' : 'In the version'}</th>
            <th className="font-normal pb-0.5">{done ? 'Before' : 'Now'}</th>
          </tr>
        </thead>
        <tbody className="align-top">{c.fields.map(f => <Row key={f.field} f={f} />)}</tbody>
      </table>
    )}
    {c.note && <p className="text-xs text-gray-600 mt-1">{c.note}</p>}
  </li>
)

const SECTIONS: Array<{ action: PlannedColumn['action']; title: string }> = [
  { action: 'add_back', title: 'Added back, empty' },
  { action: 'restore', title: 'Set up as in the version' },
  { action: 'leave', title: 'Left as they are' },
]

export const VersionPlan: React.FC<{ plan: RestoreAnswer }> = ({ plan }) => {
  const kept = plan.columns.filter(c => c.action === 'keep')
  const keptQuiet = kept.filter(c => !c.note)
  const keptSaid = kept.filter(c => c.note)
  const section = (key: string, title: string, columns: PlannedColumn[]) => (columns.length > 0 && (
    <section key={key} className="mt-4" data-testid={`setup-version-section-${key}`}>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">{title} ({columns.length})</h4>
      <ul className="divide-y divide-gray-100">
        {columns.map(c => <Column key={c.column} c={c} done={!plan.dry_run} />)}
      </ul>
    </section>
  ))
  return (
    <div className="px-6 py-4 max-h-[55vh] overflow-y-auto" data-testid="setup-version-plan">
      <p className="text-sm text-gray-800" data-testid="setup-version-message">{plan.message}</p>
      {SECTIONS.map(s => section(s.action, s.title, plan.columns.filter(c => c.action === s.action)))}
      {section('keep', 'Not in this version', keptSaid)}
      {plan.order_changed && (
        <p className="text-xs text-gray-600 mt-4">
          The columns {plan.dry_run ? 'go' : 'went'} back to the version's order. Columns it doesn't have stay
          next to the column they follow now.
        </p>
      )}
      {keptQuiet.length > 0 && (
        <p className="text-xs text-gray-600 mt-2" data-testid="setup-version-keep">
          Not in this version, so {keptQuiet.length === 1 ? 'it stays as it is' : 'they stay as they are'}:{' '}
          {keptQuiet.map(c => c.column).join(', ')}.
        </p>
      )}
    </div>
  )
}
