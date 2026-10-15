import { expect, type APIRequestContext } from '@playwright/test'
import { seedSheet } from './helpers'

// A lead list with duplicates for the remove-duplicates specs. By email:
// rows 1, 2 and 6 are one person (case and spaces differ), rows 3 and 7 another;
// rows 4 and 5 are empty and rows 8 and 9 hold a run's status, so they always
// stay. By domain: rows 1 and 2 (acme.com) and rows 4 and 5 (gamma.dev) match.
export const LEADS = [
  { Email: 'jo@acme.com', Website: 'https://www.acme.com', Name: 'Jo' },
  { Email: '  JO@Acme.com ', Website: 'acme.com', Name: 'Jo' },
  { Email: 'pat@beta.io', Website: 'beta.io', Name: 'Pat' },
  { Email: '', Website: 'http://gamma.dev/x', Name: 'Gil' },
  { Email: '', Website: 'gamma.dev', Name: '' },
  { Email: 'jo@acme.com', Website: '', Name: 'Jo Again' },
  { Email: 'pat@beta.io', Website: '', Name: '' },
  { Email: '⏭️ Not found', Website: 'delta.org', Name: 'Dee' },
  { Email: '⏭️ Not found', Website: '', Name: 'Dee' },
]
export const EMAILS_LEFT = ['jo@acme.com', 'pat@beta.io', '', '', '⏭️ Not found', '⏭️ Not found']

export async function seedLeads(api: APIRequestContext): Promise<{ tableId: string; sheetId: string }> {
  const seeded = await seedSheet(api, LEADS.length)
  for (const c of ['Email', 'Website', 'Name']) {
    expect((await api.post(`/api/sheets/${seeded.sheetId}/columns`, { data: { columnName: c } })).ok()).toBeTruthy()
  }
  const updates = LEADS.flatMap((r, rowIndex) =>
    Object.entries(r).map(([columnName, value]) => ({ rowIndex, columnName, value })))
  expect((await api.put(`/api/sheets/${seeded.sheetId}/data`, { data: { updates } })).ok()).toBeTruthy()
  return seeded
}
