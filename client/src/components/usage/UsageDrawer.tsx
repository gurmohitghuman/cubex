import React, { useState } from 'react'
import toast from 'react-hot-toast'
import { BarChart3, Download, Loader2 } from 'lucide-react'
import { Drawer, DrawerBody, DrawerHeader } from '@/components/Drawer'
import { usageAPI, type UsageAsk, type UsageGroupBy, type UsageRangeName } from '@/utils/api'
import { useUsage } from './useUsage'
import { UsageTable } from './UsageTable'
import {
  RANGE_LABELS, breakdownLine, rangeText, reusedLine, totalsLine, truncatedLine,
} from './usage-copy'

interface Props { isOpen: boolean; onClose: () => void; sheetId: string; sheetName: string }

const GROUPS: Array<{ id: UsageGroupBy; label: string }> = [
  { id: 'column', label: 'Column' }, { id: 'day', label: 'Day' }, { id: 'run', label: 'Run' },
]
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

// The sheet's Usage view: what its runs cost (AI, HTTP API and enrichment
// columns, deleted ones too), by column, day or run, over a range of days,
// with every row as a CSV download. Read from the run records, never the rows.
export const UsageDrawer: React.FC<Props> = ({ isOpen, onClose, sheetId, sheetName }) => {
  const [groupBy, setGroupBy] = useState<UsageGroupBy>('column')
  const [range, setRange] = useState<UsageRangeName>('this_month')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [downloading, setDownloading] = useState(false)
  const customReady = DAY_RE.test(from) && DAY_RE.test(to) && from <= to
  const ask: UsageAsk | null = !isOpen ? null
    : range === 'custom' ? (customReady ? { groupBy, range, from, to } : null) : { groupBy, range }
  const { report, error, loading } = useUsage(sheetId, ask)

  const pickRange = (next: UsageRangeName) => {
    // Picking days starts from the range shown.
    if (next === 'custom' && report && !from && !to) { setFrom(report.range.from); setTo(report.range.to) }
    setRange(next)
  }
  const download = async () => {
    if (!ask) return
    setDownloading(true)
    try {
      const blob = await usageAPI.csv(sheetId, ask)
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${sheetName} usage${report ? ` ${rangeText(report.range)}` : ''} by ${groupBy}.csv`
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      window.URL.revokeObjectURL(url)
    } catch {
      toast.error("Couldn't download the usage")
    } finally { setDownloading(false) }
  }
  const t = report?.totals

  return (
    <Drawer isOpen={isOpen} onClose={onClose} panelClassName="max-w-2xl">
      <DrawerHeader icon={<BarChart3 className="h-5 w-5 text-gray-700" />} title="Usage" onClose={onClose}
        description="What this sheet's runs ran and cost, by column, day or run." />
      <DrawerBody>
        <div className="flex flex-wrap items-center gap-2">
          <select className="input w-auto py-1 text-sm" value={range} aria-label="Range"
            onChange={e => pickRange(e.target.value as UsageRangeName)} data-testid="usage-range">
            {(Object.keys(RANGE_LABELS) as UsageRangeName[])
              .map(r => <option key={r} value={r}>{RANGE_LABELS[r]}</option>)}
          </select>
          {range === 'custom' && (
            <>
              <input type="date" className="input w-auto py-1 text-sm" value={from} aria-label="From"
                onChange={e => setFrom(e.target.value)} data-testid="usage-from" />
              <span className="text-sm text-gray-600">to</span>
              <input type="date" className="input w-auto py-1 text-sm" value={to} aria-label="To"
                onChange={e => setTo(e.target.value)} data-testid="usage-to" />
            </>
          )}
          <div className="flex border border-gray-300 ml-auto" role="group" aria-label="Group by">
            {GROUPS.map(g => (
              <button key={g.id} type="button" onClick={() => setGroupBy(g.id)} aria-pressed={groupBy === g.id}
                className={`px-3 py-1 text-sm ${groupBy === g.id
                  ? 'bg-cube-black text-white' : 'bg-white text-gray-700'}`}
                data-testid={`usage-by-${g.id}`}>
                {g.label}
              </button>
            ))}
          </div>
        </div>
        {range === 'custom' && !customReady && (
          <p className="text-xs text-gray-600">Pick the first and the last day.</p>
        )}

        {error ? <p className="text-sm text-red-600">{error}</p> : !report ? (
          ask && (
            <p className="text-sm text-gray-600 flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />Loading…
            </p>
          )
        ) : (
          <div className="space-y-3">
            <div className="bg-gray-50 border border-gray-200 p-3 space-y-1" data-testid="usage-totals">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-gray-600">{rangeText(report.range)} (UTC)</span>
                {loading && <Loader2 className="h-3 w-3 animate-spin text-gray-400" />}
              </div>
              <p className="text-sm font-medium text-cube-black">{totalsLine(report.totals)}</p>
              {t && breakdownLine(t) && <p className="text-xs text-gray-700">{breakdownLine(t)}</p>}
              {t && reusedLine(t) && <p className="text-xs text-gray-700">{reusedLine(t)}</p>}
            </div>
            {report.rows.length === 0
              ? <p className="text-sm text-gray-600" data-testid="usage-empty">No runs in this range.</p>
              : <UsageTable report={report} />}
            {truncatedLine(report) && <p className="text-xs text-gray-600">{truncatedLine(report)}</p>}
          </div>
        )}

        <div className="flex items-start justify-between gap-3 pt-2 border-t border-gray-200">
          <p className="text-xs text-gray-500">
            Each run counts on the day it started. Tries in the AI column dialog count as AI previews, and the AI
            that writes a formula, a rule or an HTTP request as AI helpers. Cells reused from earlier answers cost
            nothing.
          </p>
          <button type="button" onClick={download} disabled={!ask || downloading || !report?.rows.length}
            className="btn-secondary flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50"
            data-testid="usage-csv">
            {downloading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
            <span>Download CSV</span>
          </button>
        </div>
      </DrawerBody>
    </Drawer>
  )
}
