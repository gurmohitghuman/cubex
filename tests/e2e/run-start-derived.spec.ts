import { test, expect, APIRequestContext } from '@playwright/test'
import { authedApi } from './helpers'
import { freshTreg, readDb, rowsOf, waitRun } from './helpers-enrich'
import { mockTreg } from './helpers-treg'
import { waitAdded } from './helpers-list'

// Derived columns (clean, formula, lookup) follow a run's ⏳ placeholders as empty as soon as the run starts,
// instead of keeping old answers next to ⏳ while the run is going, then update to new answers when the run
// finishes or restore old answers if the run is cancelled.

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await read()
    if (ok(v)) return v
    if (Date.now() > end) throw new Error(`${what}: ${JSON.stringify(v).slice(0, 400)}`)
    await new Promise(r => setTimeout(r, 150))
  }
}

const unfollowed = (sheetId: string): number => readDb(db => db.prepare(`SELECT
  (SELECT COUNT(*) FROM autorun_pending p JOIN autorun_columns a ON a.id = p.autorun_id
    WHERE a.sheet_id = ? AND a.enabled = 1 AND a.kind IN ('clean', 'formula', 'lookup'))
  + (SELECT COUNT(*) FROM derived_span_marks m JOIN autorun_columns a ON a.id = m.autorun_id
    WHERE a.sheet_id = ? AND a.enabled = 1 AND a.kind IN ('clean', 'formula', 'lookup'))`)
  .pluck().get(sheetId, sheetId))

async function makeVisibility(api: APIRequestContext, engines: string[]) {
  for (const t of await (await api.get('/api/tables')).json()) await api.delete(`/api/tables/${t.id}`)
  const res = await api.post('/api/ai-visibility', {
    data: {
      brand: 'Acme CRM', competitors: ['Northdesk', 'Pipewell'], domain: 'acme-crm.com',
      questions: ['Best CRM for a small team?', 'Cheapest CRM for two people?'], engines,
    },
  })
  expect(res.ok(), await res.text()).toBeTruthy()
  const v = (await res.json()).aiVisibility
  const started = await (await api.post(`/api/ai-visibility/${v.id}/ask`, { data: {} })).json()
  for (const s of started.started) await waitRun(api, s.runId, ['completed'])
  await waitAdded(v.questionsSheetId)
  await until(async () => unfollowed(v.questionsSheetId), n => n === 0, 'initial derived columns')
  return v
}

test('AI visibility check again clears formulas, clean and lookup while engines run, then updates when done',
  async () => {
    test.setTimeout(120_000)
    const api = await authedApi()
    await freshTreg(api)
    const v = await makeVisibility(api, ['chatgpt', 'gemini'])
    const before = await rowsOf(api, v.questionsSheetId)
    expect(before.map(r => r['Named by'])).toEqual(['1 of 2', '1 of 2'])
    const firstAnswer = String(before[0]['ChatGPT answer'])
    expect(firstAnswer.length).toBeGreaterThan(0)

    // Add a clean column and a lookup column reading ChatGPT answer so all 3 derived kinds are verified live.
    const cleanRes = await api.post(`/api/sheets/${v.questionsSheetId}/clean-columns`, {
      data: { source: 'ChatGPT answer', cleaner: 'lowercase', column: 'Answer lower' },
    })
    expect(cleanRes.ok(), await cleanRes.text()).toBeTruthy()
    const lookupSheetRes = await api.post(`/api/tables/${v.tableId}/sheets`, { data: { name: 'Known answers' } })
    expect(lookupSheetRes.ok(), await lookupSheetRes.text()).toBeTruthy()
    const knownSheetId = (await lookupSheetRes.json()).sheet.id as string
    for (const columnName of ['Answer', 'Tag']) {
      expect((await api.post(`/api/sheets/${knownSheetId}/columns`, { data: { columnName } })).ok()).toBeTruthy()
    }
    const putRes = await api.put(`/api/sheets/${knownSheetId}/data`, {
      data: {
        updates: [
          { rowIndex: 0, columnName: 'Answer', value: firstAnswer },
          { rowIndex: 0, columnName: 'Tag', value: 'matched-old' },
        ],
      },
    })
    expect(putRes.ok(), await putRes.text()).toBeTruthy()
    const lookupRes = await api.post(`/api/sheets/${v.questionsSheetId}/lookup-columns`, {
      data: {
        column: 'Answer tag', sourceColumn: 'ChatGPT answer', otherSheetId: knownSheetId,
        matchColumn: 'Answer', returns: 'value', returnColumn: 'Tag',
      },
    })
    expect(lookupRes.ok(), await lookupRes.text()).toBeTruthy()
    await until(() => rowsOf(api, v.questionsSheetId),
      r => r[0]['Answer lower'] === firstAnswer.toLowerCase() && r[0]['Answer tag'] === 'matched-old',
      'clean and lookup filled')

    // Slow down mock treg so engines stay ⏳ Processing... while derived readers catch up.
    await mockTreg.set({ delayMs: 10_000, aiAlsoNames: { gemini: 'Acme CRM' } })
    try {
      const checkRes = await api.post(`/api/ai-visibility/${v.id}/check`, { data: {} })
      expect(checkRes.ok(), await checkRes.text()).toBeTruthy()
      const check = (await checkRes.json()).check
      expect(check.stage).toBe('done')
      expect(check.runs).toHaveLength(2)
      const changeCol = `Change since ${check.label}`

      // While both engines still hold ⏳ Processing..., every derived column must clear (not keep stale old answers).
      const mid = await until(() => rowsOf(api, v.questionsSheetId), rows =>
        rows.every(r => r['ChatGPT answer'] === '⏳ Processing...' && r['Gemini answer'] === '⏳ Processing...'
          && !r['Named by'] && !r[changeCol] && !r['You in ChatGPT'] && !r['Answer lower'] && !r['Answer tag']),
        'derived columns cleared while engines still running', 15_000)
      expect(mid.every(r => r['ChatGPT answer'] === '⏳ Processing...')).toBe(true)

      await mockTreg.set({ delayMs: 0 })
      for (const r of check.runs) await waitRun(api, r.runId, ['completed'])
      await until(async () => unfollowed(v.questionsSheetId), n => n === 0, 'derived columns after completion')
      const after = await rowsOf(api, v.questionsSheetId)
      expect(after.map(r => r['Named by'])).toEqual(['2 of 2', '2 of 2'])
      expect(after.map(r => r[changeCol])).toEqual(['Up 1', 'Up 1'])
      expect(after[0]['Answer lower']).toBe(String(after[0]['ChatGPT answer']).toLowerCase())
      expect(after[0]['Answer tag']).toBe('matched-old')
    } finally {
      await mockTreg.set({ delayMs: 0 })
      await api.dispose()
    }
  })

test('cancelling a rerun after derived columns cleared restores both the old answers and the derived columns',
  async () => {
    test.setTimeout(120_000)
    const api = await authedApi()
    await freshTreg(api)
    const v = await makeVisibility(api, ['chatgpt'])
    const before = await rowsOf(api, v.questionsSheetId)
    expect(before.map(r => r['Named by'])).toEqual(['1 of 1', '1 of 1'])
    const oldAnswer = String(before[0]['ChatGPT answer'])

    await mockTreg.set({ delayMs: 12_000 })
    try {
      const rerun = await api.post(`/api/enrich/sheets/${v.questionsSheetId}/reruns`, {
        data: { column: 'ChatGPT', mode: 'all', status: 'any', estimateOnly: false, callAgain: true },
      })
      expect(rerun.ok(), await rerun.text()).toBeTruthy()
      const { runId } = await rerun.json()

      // Wait until formulas clear to empty while ChatGPT answer still holds ⏳ Processing...
      await until(() => rowsOf(api, v.questionsSheetId), rows =>
        rows.every(r => r['ChatGPT answer'] === '⏳ Processing...' && !r['Named by'] && !r['You in ChatGPT']),
        'formulas cleared while rerun is going', 15_000)

      // Cancel mid-run: old answers return and formulas restore them.
      const cancel = await api.post(`/api/http/jobs/${runId}/control`, { data: { action: 'cancel' } })
      expect(cancel.ok(), await cancel.text()).toBeTruthy()
      await waitRun(api, runId, ['cancelled'])
      await until(async () => unfollowed(v.questionsSheetId), n => n === 0, 'formulas restored after cancel')
      const after = await rowsOf(api, v.questionsSheetId)
      expect(after[0]['ChatGPT answer']).toBe(oldAnswer)
      expect(after.map(r => r['Named by'])).toEqual(['1 of 1', '1 of 1'])
      expect(after[0]['You in ChatGPT']).toBe(before[0]['You in ChatGPT'])
    } finally {
      await mockTreg.set({ delayMs: 0 })
      await api.dispose()
    }
  })
