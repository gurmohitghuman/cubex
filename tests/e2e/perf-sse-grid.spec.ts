// PERF measurement (not a pass/fail gate): real-browser main-thread cost of the
// SSE-result grid-update path, OLD (fresh row objects every update, per-event) vs
// NEW (identity-preserving rowData + per-frame coalesced batch). Run via the e2e
// harness; prints a before/after table. Mirrors what AGGridSpreadsheet does:
// data → rowData useMemo (data.map → row objects) → AgGridReact rowData prop.
import { test } from '@playwright/test'
import { authedApi, seedSheet, BASE } from './helpers'

const ROWS = 5000
const COLS = 12
const RESULTS = 2000      // a 2k-row run (kept modest so the OLD tight loop finishes)
const BURST = 200         // SSE poll returns up to 200 per 400ms tick

test('PERF: SSE grid-update cost OLD vs NEW (real AG Grid, real DOM)', async ({ page, context }) => {
  test.setTimeout(180_000)
  const api = await authedApi()
  const { tableId, sheetId } = await seedSheet(api, ROWS)
  // Widen the sheet to COLS columns so each row object is realistically sized.
  for (let c = 1; c < COLS; c++) {
    await api.post(`/api/sheets/${sheetId}/columns`, { data: { columnName: `col${c}` } })
  }
  const cookies = await api.storageState()
  await context.addCookies(cookies.cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await page.locator('.ag-row').first().waitFor({ state: 'visible', timeout: 30_000 })

  const result = await page.evaluate(async ({ ROWS, COLS, RESULTS, BURST }) => {
    // Reach the real AG Grid api by walking the React fiber hook chain off the grid root.
    const findGridApi = (): any => {
      const el = document.querySelector('.ag-root-wrapper') as any
      if (!el) return null
      const fk = Object.keys(el).find(k => k.startsWith('__reactFiber$'))
      if (!fk) return null
      const seen = new Set<any>(); let api: any = null
      const walk = (fiber: any, depth: number) => {
        if (!fiber || depth > 60 || seen.has(fiber) || api) return
        seen.add(fiber)
        let h = fiber.memoizedState, hops = 0
        while (h && hops < 40 && !api) {
          if (h.memoizedState && typeof h.memoizedState.setGridOption === 'function') api = h.memoizedState
          h = h.next; hops++
        }
        walk(fiber.child, depth + 1); walk(fiber.sibling, depth + 1); walk(fiber.return, depth + 1)
      }
      walk(el[fk], 0)
      return api
    }
    const api = findGridApi()
    if (!api?.setGridOption) return { error: 'no grid api', hasGrid: !!document.querySelector('.ag-root-wrapper') }

    const baseRows: any[] = []
    for (let r = 0; r < ROWS; r++) {
      const o: any = { __rowIndex: r }
      for (let c = 0; c < COLS; c++) o[`col${c}`] = `v${r}_${c}`
      baseRows.push(o)
    }

    // Measure wall time + main-thread long-task time around a fn.
    const measure = async (fn: () => Promise<void>) => {
      let longTaskMs = 0, longTaskCount = 0
      const obs = new PerformanceObserver(list => {
        for (const e of list.getEntries()) { longTaskMs += e.duration; longTaskCount++ }
      })
      try { obs.observe({ entryTypes: ['longtask'] }) } catch {}
      const t0 = performance.now()
      await fn()
      await new Promise(r => requestAnimationFrame(() => r(null)))
      const wall = performance.now() - t0
      obs.disconnect()
      return { wallMs: Math.round(wall), longTaskMs: Math.round(longTaskMs), longTaskCount }
    }

    // Both paths process the SAME 5000 results in BURSTS of 200 (one SSE poll tick).
    // The difference is what happens PER BURST:
    //  OLD: 200 separate setGridOption calls, each handing AG Grid an array of
    //       all-fresh row objects → AG Grid re-diffs all ROWS rows, 200×/burst.
    //  NEW: 1 setGridOption per burst, identity-preserving (untouched rows keep
    //       their ref) → AG Grid's getRowId diff touches only the changed rows.
    // We pace bursts ~real (a small gap) and sum the main-thread long-task time —
    // that sum IS the jank the user feels while scrolling/editing during a run.
    let applied = 0
    const oldRun = async () => {
      let cur = baseRows.map(r => ({ ...r }))
      for (let i = 0; i < RESULTS; i += BURST) {
        const n = Math.min(BURST, RESULTS - i)
        for (let k = 0; k < n; k++) {
          cur = cur.map(r => ({ ...r }))           // fresh objects, every row, every event
          cur[(i + k) % ROWS].col0 = `r${i + k}`
          api.setGridOption('rowData', cur); applied++
        }
        await new Promise(r => setTimeout(r, 16))  // ~one frame between bursts
      }
    }
    const newRun = async () => {
      let cur = baseRows.map(r => ({ ...r }))
      for (let i = 0; i < RESULTS; i += BURST) {
        const n = Math.min(BURST, RESULTS - i)
        const changed = new Set<number>()
        for (let k = 0; k < n; k++) changed.add((i + k) % ROWS)
        cur = cur.map(r => changed.has(r.__rowIndex) ? { ...r, col0: `r${i}` } : r)  // keep ref if unchanged
        api.setGridOption('rowData', cur); applied++
        await new Promise(r => setTimeout(r, 16))
      }
    }

    const oldM = await measure(oldRun); const oldApplied = applied; applied = 0
    api.setGridOption('rowData', baseRows.map(r => ({ ...r })))
    await new Promise(r => setTimeout(r, 300))
    const newM = await measure(newRun); const newApplied = applied
    return { oldM: { ...oldM, gridUpdates: oldApplied }, newM: { ...newM, gridUpdates: newApplied },
      jankReductionLongTaskMs: oldM.longTaskMs - newM.longTaskMs,
      speedupLongTask: +(oldM.longTaskMs / Math.max(1, newM.longTaskMs)).toFixed(1) }
  }, { ROWS, COLS, RESULTS, BURST })

  // eslint-disable-next-line no-console
  console.log('\n=== REAL-BROWSER SSE grid-update cost (AG Grid v34, ' + ROWS + ' rows, ' + RESULTS + ' results) ===')
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2))
})
