import React from 'react'
import { X } from 'lucide-react'
import type { EnrichToolDetail } from '@/utils/api'
import { formatCost } from '@/components/ai-modal/format'
import { plural } from '@/lib/utils'
import { listProviderRows, perRowRange, type ListDraft, type SheetRef } from './list-draft'
import { uniqueName } from './outputs'
import type { ProviderRow } from './providers'
import { ListFieldsPicker } from './ListFieldsPicker'
import { humanize } from './labels'

interface Props {
  tool: EnrichToolDetail
  list: ListDraft
  update: (patch: Partial<ListDraft>) => void
  columns: string[]                 // this sheet's columns (to copy)
  sheets: SheetRef[] | null         // the table's other sheets (null: loading)
  sent: Set<string>                 // inputs mapped
  destProblem: string | null
  // The fields come from results this column already has (Edit), with the count they're out of.
  fieldsFrom: number | null
}

type RowProps = { label: string; htmlFor?: string; children: React.ReactNode }
const Row: React.FC<RowProps> = ({ label, htmlFor, children }) => (
  <div className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] items-start gap-2">
    <label htmlFor={htmlFor} className="text-sm text-gray-700 pt-2">{label}</label>
    <div className="space-y-1 min-w-0">{children}</div>
  </div>
)

const one = (usd: number) => (usd === 0 ? 'free' : formatCost(usd))
// A provider can serve a list job from more than one endpoint: its cheapest to its dearest.
const price = (r: ProviderRow) => (r.usd === null ? 'price varies'
  : r.usdMax !== null && r.usdMax > r.usd ? `${one(r.usd)} to ${formatCost(r.usdMax)}` : one(r.usd))

// What "Results per row" does: asked of the provider when the tool takes
// treg's limit, else only what Cubex keeps (the provider sends its own number).
function perRowNote(tool: EnrichToolDetail): string {
  const name = tool.providerName ?? tool.provider
  const { max } = perRowRange(tool)
  if (tool.kind === 'waterfall') {
    return `More results can cost more: a provider that charges per result bills each one. Up to ${max}.`
  }
  if (tool.inputs.some(i => i.name === 'limit')) {
    return (tool.price.type === 'per_result' ? `${name} charges for each result it returns.`
      : `${name} is asked for this many.`) + ` Up to ${max}.`
  }
  return `Cubex adds at most this many per row. How many ${name} returns is up to its own inputs`
    + (tool.price.type === 'per_result' ? ', and it charges for each one (the estimate counts 20 a row).' : '.')
}

// U8: where each result goes as a row, how many per row (the price dial), the
// one provider asked, the columns copied from this row, and the fields kept.
export const ListRowsPane: React.FC<Props> = (p) => {
  const { tool, list, update, columns, sheets, sent, destProblem, fieldsFrom } = p
  const providers = tool.kind === 'waterfall' ? listProviderRows(tool, sent) : []
  const chosen = providers.find(r => r.provider.toLowerCase() === list.provider?.toLowerCase())
  const lost = list.provider && !providers.some(r => r.provider.toLowerCase() === list.provider!.toLowerCase())
  const copyable = columns.filter(c => !list.copy.includes(c))
  const destValue = list.dest.kind === 'new' ? 'new' : list.dest.sheetId
  const newName = uniqueName(humanize(tool.list?.field ?? 'results'), (sheets ?? []).map(s => s.name))
  const nameOf = (slug: string) => (tool.providers ?? []).find(r => r.provider.toLowerCase() === slug.toLowerCase())
    ?.name ?? slug
  return (
    <div className="space-y-3" data-testid="enrich-list-rows">
      <Row label="Put each result in" htmlFor="enrich-list-dest">
        <select id="enrich-list-dest" className="input w-full" value={destValue}
          onChange={e => update({ dest: e.target.value === 'new'
            ? { kind: 'new', name: list.dest.kind === 'new' ? list.dest.name : newName }
            : { kind: 'sheet', sheetId: e.target.value } })}>
          <option value="new">A new sheet</option>
          {list.dest.kind === 'sheet' && !sheets?.some(s => s.id === destValue) && (
            <option value={destValue}>{sheets ? 'A deleted sheet' : 'Loading the sheets…'}</option>
          )}
          {(sheets ?? []).filter(s => !s.current).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        {list.dest.kind === 'new' && (
          <input className={`input w-full ${destProblem ? '!border-red-300' : ''}`} value={list.dest.name}
            onChange={e => update({ dest: { kind: 'new', name: e.target.value } })} aria-label="New sheet name"
            data-testid="enrich-list-dest-name" />
        )}
        {destProblem
          ? <p className="text-xs text-red-600" data-testid="enrich-list-dest-problem">{destProblem}</p>
          : <p className="text-xs text-gray-500">
            {list.dest.kind === 'new'
              ? 'A new tab of this table, made when the run starts.' : 'New rows go after the rows it has.'}
          </p>}
      </Row>

      <Row label="Results per row" htmlFor="enrich-list-max">
        <input id="enrich-list-max" type="number" min={perRowRange(tool).min} max={perRowRange(tool).max}
          className="input w-24"
          value={Number.isFinite(list.maxItems) ? list.maxItems : ''}
          onChange={e => update({ maxItems: e.target.value === '' ? NaN : Math.floor(Number(e.target.value)) })} />
        <p className="text-xs text-gray-500">
          {perRowNote(tool)}
        </p>
      </Row>

      {tool.kind === 'waterfall' ? (
        <Row label="Provider" htmlFor="enrich-list-provider">
          <select id="enrich-list-provider" className="input w-full" value={list.provider ?? ''}
            onChange={e => update({ provider: e.target.value || null })}>
            {!list.provider && <option value="">Pick a provider</option>}
            {lost && (
              <option value={list.provider!}>{nameOf(list.provider!)} (can&apos;t search with these inputs)</option>
            )}
            {providers.map(r => (
              <option key={r.provider} value={r.provider}>
                {r.name} · {price(r)}
              </option>
            ))}
          </select>
          <p className="text-xs text-gray-500">
            {chosen?.hitRate != null && `${chosen.name}: ${Math.round(chosen.hitRate * 100)}% found at treg. `}
            Prices are treg&apos;s catalog prices; the estimate below shows what a row can cost. This enrichment asks
            one provider, so every row it adds has that provider&apos;s fields.
          </p>
        </Row>
      ) : (
        <p className="text-xs text-gray-600">
          Rows come from <span className="font-medium">{tool.list?.field}</span> in {tool.providerName ?? tool.provider}
          &apos;s answer, as its example at treg shows it.
        </p>
      )}

      <Row label="Also copy from this row">
        <div className="flex flex-wrap items-center gap-1.5">
          {list.copy.map(c => (
            <span key={c}
              className="inline-flex items-center gap-1 border border-gray-300 bg-white px-2 py-0.5 text-xs">
              {c}
              <button type="button" aria-label={`Stop copying ${c}`} className="text-gray-400 hover:text-gray-700"
                onClick={() => update({ copy: list.copy.filter(x => x !== c) })}><X className="h-3 w-3" /></button>
            </span>
          ))}
          {copyable.length > 0 && (
            <select className="input py-0.5 text-xs w-auto" value="" aria-label="Copy another column"
              onChange={e => { if (e.target.value) update({ copy: [...list.copy, e.target.value] }) }}>
              <option value="">+ Add</option>
              {copyable.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
        </div>
        <p className="text-xs text-gray-500">So each new row says which row it came from.</p>
      </Row>

      <div className="space-y-1.5">
        <h4 className="meta-label">Fields to keep</h4>
        {list.fields ? (
          <ListFieldsPicker fields={list.fields} onChange={fields => update({ fields })} results={fieldsFrom}
            dedupePath={list.dedupePath} onDedupe={dedupePath => update({ dedupePath })} />
        ) : (
          <p className="text-xs text-gray-600" data-testid="enrich-list-fields-later">
            treg returns each provider&apos;s own fields, and its catalog doesn&apos;t list them. Run on a few rows
            first: you then pick the fields to keep from what came back, and those rows are added.
          </p>
        )}
      </div>
    </div>
  )
}

export function listSummary(list: ListDraft, sheets: SheetRef[] | null): string {
  const where = list.dest.kind === 'new' ? `New sheet ${list.dest.name.trim() || ''}`.trim()
    : sheets?.find(s => s.id === (list.dest as { sheetId: string }).sheetId)?.name ?? 'Another sheet'
  const per = Number.isFinite(list.maxItems) && list.maxItems > 0 ? `${plural(list.maxItems, 'result')} per row` : ''
  return [where, per].filter(Boolean).join(' · ')
}
