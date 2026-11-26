// run_enrichment's arguments on a sheet or on items (mcp/enrich-items.ts misplacedArgument): with items, an argument
// only a sheet takes is refused by name, and so is sheet_id beside items; on a sheet, an argument only items take is
// refused, and sheet_id and column_name are needed. Pure: no database.
import assert from 'node:assert/strict'
import itemsMod from '../../server/src/mcp/enrich-items'
const { misplacedArgument } = itemsMod as typeof import('../../server/src/mcp/enrich-items')

const items = [{ full_name: 'Ada Lovelace', domain: 'acme.com' }]
const tool = 'treg.people.email.find'

// With items: only tool_id, items, fields, estimate_only, max_cost_usd, allow_unpriced and webhook_id.
assert.equal(misplacedArgument({ tool_id: tool, items }), null)
assert.equal(misplacedArgument({ tool_id: tool, items, fields: ['email'], estimate_only: false, max_cost_usd: 5,
  allow_unpriced: true, webhook_id: 'w' }), null)
assert.equal(misplacedArgument({ tool_id: tool, items, sheet_id: 's' }), 'Pass sheet_id or items, not both.')
assert.match(misplacedArgument({ tool_id: tool, items, column_name: 'Email', test: true })!,
  /^column_name, test go with sheet_id, not items\./)
// An argument left undefined isn't one sent.
assert.equal(misplacedArgument({ tool_id: tool, items, column_name: undefined }), null)

// On a sheet: items' own arguments are refused, and the sheet and its status column are needed.
assert.equal(misplacedArgument({ tool_id: tool, sheet_id: 's', column_name: 'Email' }), null)
assert.match(misplacedArgument({ tool_id: tool, sheet_id: 's', column_name: 'Email', max_cost_usd: 1, fields: [] })!,
  /^max_cost_usd, fields go with items, not sheet_id\. On a sheet, spend_limit_usd caps the run/)
assert.match(misplacedArgument({ tool_id: tool, column_name: 'Email' })!, /^Pass sheet_id .* or items/)
assert.equal(misplacedArgument({ tool_id: tool, sheet_id: 's' }),
  'column_name is needed with sheet_id: the status column.')

console.log('enrich-items-args: ok')
