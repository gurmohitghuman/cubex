// Background reloads keep the viewport (client/src/hooks/sheet/reloadWindow.ts):
// which rows a silent reload refetches, how pages combine, and how a deep slice
// merges into the held rows. Pure: no DB, no network. Value imports are
// relative (tsx has no "@/" alias).
import {
  planWindowReload, fetchWindow, mergeReloadedWindow, commitMergedWindow,
} from '../../client/src/hooks/sheet/reloadWindow'
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
    JSON.stringify(p(600, 400)) === '{"offset":0,"limit":600,"keepTail":true,"windowStart":0}')
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

  // --- a window that starts deep (search jumped there): places stay places in the view
  const at = (d: SheetData, start: number) => ({ ...d, data: { ...d.data, windowStart: start } })
  check('a deep window that fits is refetched whole from its own start',
    JSON.stringify(p(5600, 400, 5000)) === '{"offset":5000,"limit":600,"keepTail":true,"windowStart":5000}')
  check('a short deep window (the sheet\'s end) still asks for the first-page floor',
    p(5010, 0, 5000).offset === 5000 && p(5010, 0, 5000).limit === INITIAL_ROW_LOAD)
  check('a big deep window, viewport deep in it: a slice around the viewport',
    p(17000, 6000, 5000).offset === 5000 + 6000 - SILENT_RELOAD_LEAD_ROWS)
  check('…and the slice stays inside the held window',
    p(17000, 11990, 5000).offset === 17000 - SILENT_RELOAD_MAX_ROWS)
  const held = at(sheet(range(5000, 5600)), 5000)
  const whole = mergeReloadedWindow(held, sheet(range(5000, 5600), {}, 'new'),
    { offset: 5000, limit: 600, keepTail: true, windowStart: 5000 })
  check('a whole deep window replaced keeps its start',
    whole.data.windowStart === 5000 && whole.data.rows.length === 600 && val(whole, 5100) === 'new5100')
  const bigHeld = at(sheet(range(5000, 17000)), 5000)
  const slice = mergeReloadedWindow(bigHeld, sheet(range(10750, 14750), {}, 'new'),
    { offset: 10750, limit: SILENT_RELOAD_MAX_ROWS, keepTail: false, windowStart: 5000 })
  check('a deep slice of a deep window: rows above it kept, start kept',
    slice.data.windowStart === 5000 && slice.data.rows[0].rowIndex === 5000 && val(slice, 6000) === 'old6000'
      && val(slice, 11000) === 'new11000' && !idx(slice).includes(16000))
  const moved = at(sheet(range(0, 300)), 0)
  check('a reload planned for a window that moved meanwhile leaves the held rows alone',
    mergeReloadedWindow(moved, sheet(range(5000, 5600), {}, 'new'),
      { offset: 5000, limit: 600, keepTail: true, windowStart: 5000 }) === moved)

  const gone = mergeReloadedWindow(at(sheet(range(5000, 5600)), 5000), sheet([]),
    { offset: 5000, limit: 600, keepTail: true, windowStart: 5000 })
  check('a deep window that comes back empty (rows deleted below its start) is an empty window at the top',
    gone.data.rows.length === 0 && gone.data.windowStart === 0)
  // commitMergedWindow: a window that moved meanwhile keeps its rows and asks for a new reload.
  let state: SheetData | null = at(sheet(range(0, 300)), 0), loaded = 300, asked = 0
  type Up<T> = T | ((p: T) => T)
  const apply = <T,>(u: Up<T>, v: T): T => (typeof u === 'function' ? (u as (p: T) => T)(v) : u)
  const setData = (u: Up<SheetData | null>) => { state = apply(u, state) }
  const setLoaded = (u: Up<number>) => { loaded = apply(u, loaded) }
  commitMergedWindow(setData as never, setLoaded as never, sheet(range(5000, 5600), {}, 'new'),
    { offset: 5000, limit: 600, keepTail: true, windowStart: 5000 }, () => { asked++ })
  await new Promise(resolve => setTimeout(resolve, 5))
  check('a reload for a window that moved is dropped and planned again',
    asked === 1 && idx(state!)[0] === 0 && loaded === 300)

  if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
  console.log('\nok   reload window')
}
main()
