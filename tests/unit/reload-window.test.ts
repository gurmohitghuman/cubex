// Background reloads keep the viewport (client/src/hooks/sheet/reloadWindow.ts):
// which rows a silent reload refetches, how pages combine, and how a deep slice
// merges into the held rows. Pure: no DB, no network. Value imports are
// relative (tsx has no "@/" alias).
import { planWindowReload, fetchWindow, mergeReloadedWindow } from '../../client/src/hooks/sheet/reloadWindow'
import {
  INITIAL_ROW_LOAD, SILENT_RELOAD_MAX_ROWS, SILENT_RELOAD_LEAD_ROWS, SILENT_RELOAD_PAGE_ROWS,
} from '../../client/src/lib/constants'
import type { SheetData } from '../../client/src/utils/api'

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}

type Extra = Partial<SheetData['sheet']>
const sheet = (rows: number[], extra: Extra = {}, tag = 'old', columns = ['v']): SheetData => ({
  sheet: { id: 's1', empty_filter: null, column_filters: null, data_version: 1, row_generation: 0, ...extra },
  data: { rows: rows.map(i => ({ rowIndex: i, data: { v: `${tag}${i}` } })), columns, totalRows: 9000 },
} as unknown as SheetData)
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i)
const idx = (d: SheetData) => d.data.rows.map(r => r.rowIndex)
const val = (d: SheetData, i: number) => d.data.rows.find(r => r.rowIndex === i)?.data.v

async function main() {
  // --- planWindowReload
  const p = planWindowReload
  check('a window that fits is refetched whole from the top (keeping a mid-reload page)',
    JSON.stringify(p(600, 400)) === '{"offset":0,"limit":600,"keepTail":true}')
  check('never below the first-page floor', p(10, 0).limit === INITIAL_ROW_LOAD)
  check('the user\'s case (2,300 held, viewport 1,500): all of it, from the top',
    p(2300, 1500).offset === 0 && p(2300, 1500).limit === 2300)
  check('bigger than the cap, viewport shallow: from the top up to the cap',
    p(9000, 1500).offset === 0 && p(9000, 1500).limit === SILENT_RELOAD_MAX_ROWS)
  check('no viewport known: from the top', p(9000, null).offset === 0)
  const deep = p(12000, 6000)
  check('very deep viewport: a cap-sized slice starting just above it',
    deep.offset === 6000 - SILENT_RELOAD_LEAD_ROWS && deep.limit === SILENT_RELOAD_MAX_ROWS)
  check('the slice stays inside the held window', p(9000, 8990).offset === 9000 - SILENT_RELOAD_MAX_ROWS)

  // --- fetchWindow: pages, end of sheet, and a change between pages
  const server = (n: number, versionAt: (offset: number) => number = () => 1) => {
    const calls: Array<[number, number]> = []
    const getData = async (_id: string, limit: number, offset: number) => {
      calls.push([offset, limit])
      return sheet(range(offset, Math.min(n, offset + limit)), { data_version: versionAt(offset) }, 'new')
    }
    return { calls, getData }
  }
  const s1 = server(2300)
  const w = await fetchWindow(s1.getData, 's1', 0, 2300)
  check('fetched in server-sized pages', JSON.stringify(s1.calls) === JSON.stringify(
    [[0, SILENT_RELOAD_PAGE_ROWS], [1000, SILENT_RELOAD_PAGE_ROWS], [2000, 300]]))
  check('pages combine in order', !!w && w.data.rows.length === 2300 && idx(w).every((r, i) => r === i))
  const s2 = server(1500)
  const short = await fetchWindow(s2.getData, 's1', 0, 3000)
  check('stops at the end of the sheet', short?.data.rows.length === 1500 && s2.calls.length === 2)
  const s3 = server(2300, offset => (offset >= 1000 ? 2 : 1))
  check('a change between pages discards the result', (await fetchWindow(s3.getData, 's1', 0, 2300)) === null)

  // --- mergeReloadedWindow (deep slice only; from the top it is a replace)
  const prev = sheet(range(0, 9000))
  const fresh = sheet(range(5750, 9000), {}, 'new')
  const top = (limit: number, keepTail: boolean) => ({ offset: 0, limit, keepTail })
  const deepAt = (offset: number) => ({ offset, limit: SILENT_RELOAD_MAX_ROWS, keepTail: false })
  check('from the top through the viewport: rows below dropped',
    mergeReloadedWindow(prev, sheet(range(0, 4000)), top(4000, false)).data.rows.length === 4000)
  // Whole held window refetched (2,300) while a scroll-end page added 2,300..2,499.
  const raced = mergeReloadedWindow(sheet(range(0, 2500)), sheet(range(0, 2300), {}, 'new'), top(2300, true))
  check('a page that landed mid-reload is kept (whole-window plan)',
    raced.data.rows.length === 2500 && val(raced, 100) === 'new100' && val(raced, 2400) === 'old2400')
  check('…but a short result (sheet shrank) is a plain replace',
    mergeReloadedWindow(sheet(range(0, 2500)), sheet(range(0, 2200)), top(2300, true)).data.rows.length === 2200)
  check('…and a changed filter is a plain replace', mergeReloadedWindow(sheet(range(0, 2500)),
    sheet(range(0, 2300), { empty_filter: '{"v":"empty"}' }), top(2300, true)).data.rows.length === 2300)
  const m = mergeReloadedWindow(prev, sheet(range(5750, 8000), {}, 'new'), deepAt(5750))
  check('deep slice: rows above kept, slice replaced, rows below dropped',
    m.data.rows.length === 8000 && val(m, 10) === 'old10' && val(m, 6000) === 'new6000' && !idx(m).includes(8500))
  check('order stays by rowIndex', idx(m).every((r, i, a) => i === 0 || a[i - 1] < r))
  // Rows deleted ABOVE the slice elsewhere: server ordinal 5750 is now rowIndex 5850.
  check('a delete above the slice (ordinal drift) → empty window, refill reloads',
    mergeReloadedWindow(prev, sheet(range(5850, 9000), {}, 'new'), deepAt(5750)).data.rows.length === 0)
  check('a changed filter → empty window',
    mergeReloadedWindow(prev, sheet(range(5750, 9000), { empty_filter: '{"v":"empty"}' }), deepAt(5750))
      .data.rows.length === 0)
  check('a column gone (renamed/deleted elsewhere) → empty window',
    mergeReloadedWindow(prev, sheet(range(5750, 9000), {}, 'new', ['w']), deepAt(5750)).data.rows.length === 0)
  check('a column added (run start) still fits',
    mergeReloadedWindow(prev, sheet(range(5750, 9000), {}, 'new', ['v', 'Out']), deepAt(5750))
      .data.rows.length === 9000)
  check('an empty slice → empty window', mergeReloadedWindow(prev, sheet([]), deepAt(5750)).data.rows.length === 0)
  check('no previous data → empty window', mergeReloadedWindow(null, fresh, deepAt(5750)).data.rows.length === 0)

  if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
  console.log('\nok   reload window')
}
main()
