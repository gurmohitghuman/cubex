import { test, expect } from '@playwright/test'
import { authedApi } from './helpers'
import { mockTreg } from './helpers-treg'
import { expectBilledOnce, freshTreg, ledger, rowsOf, seedLeadRows, startRun, verifiedEmailRun, waitRun } from './helpers-enrich'

// Verified work email against the mock treg (plan Verification #7): a guess
// that passes, a finder-verified address that skips the check, an invalid
// address that sends the loop to other providers, a repeat address that skips
// its paid check, and each strategy. Every key is billed once.

const callsTo = async (tool: string, needle: string) =>
  (await mockTreg.requests()).filter(r => r.path === `/call/${tool}` && r.body.toLowerCase().includes(needle)).length

test('a guess that passes needs no find', async () => {
  test.setTimeout(60_000)
  const api = await authedApi()
  await freshTreg(api)
  const { sheetId } = await seedLeadRows(api, [{ Name: 'Ada Lovelace', Website: 'https://www.acme.example/about' }])
  const runId = await startRun(api, sheetId, verifiedEmailRun({ email: { accept: 'safest', guess: true, pattern: 'first.last' } }))
  const s = await waitRun(api, runId, ['completed'])
  expect(s.rows.completed).toBe(1)
  expect(s.toolName).toBe('Verified work email')
  const [row] = await rowsOf(api, sheetId)
  expect(row['Work email']).toBe('✅ Valid')
  expect(row.Email).toBe('ada.lovelace@acme.example')
  expect(row['Found by']).toBe('Pattern guess')
  expect(row['Checked by']).toBe('Kitt AI')
  expect(await callsTo('treg.people.email.find', 'acme')).toBe(0)
  expect(ledger(runId).map(c => c.attempt)).toEqual(['g1'])
  await expectBilledOnce([runId])
  await api.dispose()
})

test('finder-verified, retry other providers, repeat address, not found', async () => {
  test.setTimeout(60_000)
  const api = await authedApi()
  await freshTreg(api, {
    verifiedDomains: ['verified.example'],
    sameEmail: ['dup.example'],
    verdicts: { 'alan.turing@retry.example': 'invalid', 'linus.torvalds@dup.example': 'invalid' },
  })
  const { sheetId } = await seedLeadRows(api, [
    { Name: 'Grace Hopper', Website: 'verified.example' },
    { Name: 'Alan Turing', Website: 'retry.example' },
    { Name: 'Linus Torvalds', Website: 'dup.example' },
    { Name: 'Nobody Example', Website: 'nowhere.example' },
  ])
  const runId = await startRun(api, sheetId, verifiedEmailRun())
  await waitRun(api, runId, ['completed'])
  const [grace, alan, linus, nobody] = await rowsOf(api, sheetId)

  // The finder marked it verified: accepted without a paid check.
  expect(grace['Work email']).toBe('✅ Valid')
  expect(grace.Email).toBe('grace.hopper@verified.example')
  expect(grace['Checked by']).toBe(grace['Found by'])
  expect(await callsTo('treg.people.email.verify', 'grace')).toBe(0)

  // Invalid from the first provider: found again without it, by another.
  expect(alan['Work email']).toBe('✅ Valid')
  expect(alan.Email).toBe('aturing@retry.example')
  expect(alan['Found by']).toBe('Kitt AI')
  const retry = (await mockTreg.requests()).filter(r => r.path === '/call/treg.people.email.find' && r.body.includes('retry.example'))
  expect(retry).toHaveLength(2)
  expect(retry[1].headers['x-treg-route-exclude']).toContain('quickenrich')

  // The same address again: no second paid check, and the loop stops at 2 repeats.
  expect(linus['Work email']).toBe('⏭️ No valid email found')
  expect(linus.Email).toBe('')
  expect(linus['Email status']).toBe('invalid')
  expect(await callsTo('treg.people.email.verify', 'linus')).toBe(1)
  expect(await callsTo('treg.people.email.find', 'dup.example')).toBe(3)

  expect(nobody['Work email']).toBe('⏭️ Not found')
  expect(nobody.Email).toBe('')
  // wiza answers later (async): it is excluded on every find, never called.
  const finds = (await mockTreg.requests()).filter(r => r.path === '/call/treg.people.email.find')
  expect(finds.every(r => (r.headers['x-treg-route-exclude'] ?? '').split(',').includes('wiza'))).toBe(true)
  await expectBilledOnce([runId])
  await api.dispose()
})

test('each strategy accepts what it says', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  await freshTreg(api)
  const { sheetId } = await seedLeadRows(api, [
    { Name: 'Kat Jones', Website: 'catchall.example' },
    { Name: 'Rita Risky', Website: 'riskyco.example' },
  ])
  const runs: string[] = []
  for (const accept of ['safest', 'balanced', 'wide']) {
    const runId = await startRun(api, sheetId, verifiedEmailRun({
      columnName: `Email ${accept}`, email: { accept, guess: false, pattern: 'first.last' },
      outputs: [{ key: 'email', path: '$.output.email', columnName: `Address ${accept}` }],
    }))
    await waitRun(api, runId, ['completed'])
    runs.push(runId)
  }
  const [kat, rita] = await rowsOf(api, sheetId)
  expect(kat['Email safest']).toBe('⏭️ Only a catch-all address (not accepted)')
  expect(kat['Address safest']).toBe('')
  expect(kat['Email balanced']).toBe('✅ Catch-all')
  expect(kat['Address balanced']).toBe('kat.jones@catchall.example')
  expect(kat['Email wide']).toBe('✅ Catch-all')
  expect(rita['Email safest']).toBe('⏭️ Only a risky address (not accepted)')
  expect(rita['Email balanced']).toBe('⏭️ Only a risky address (not accepted)')
  expect(rita['Email wide']).toBe('✅ Risky')
  await expectBilledOnce(runs)
  await api.dispose()
})
