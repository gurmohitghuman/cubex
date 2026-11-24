// The duplicate-header refusals of a CSV import (lib/csv-import-parse.ts) quote the header, and the message goes
// into the API answer and the server log (which `cubex logs` prints): no control character (ESC, C1, a line break,
// a direction control) and no more than a set length of it may get there; the header still reads as itself.
import assert from 'node:assert/strict'
import parseMod from '../../server/src/lib/csv-import-parse'
const { scanCsvText, CsvHeaderCollisionError } = parseMod as typeof import('../../server/src/lib/csv-import-parse')

const CONTROLS = /[\u0000-\u001F\u007F-\u009F؜‎‏‪-‮⁦-⁩]/
const refusal = async (csv: string): Promise<string> => {
  try { await scanCsvText(csv); } catch (e) {
    assert.ok(e instanceof CsvHeaderCollisionError, String(e))
    return e.message
  }
  throw new Error('not refused')
}

// Two byte-identical headers carrying an ANSI escape, a C1 character and a direction control.
const evil = 'Name\u001b[31m\u0085‮evil'
const same = await refusal(`"${evil}","${evil}"\n1,2\n`)
assert.ok(!CONTROLS.test(same), JSON.stringify(same))
assert.ok(same.includes('Name[31mevil'), same)
console.log('ok   two columns of one name: no control character in the message, the name still readable')

// Two headers that sanitize to one name: both quoted, cleaned.
const collide = await refusal('"Total","Total\u0007\u0085"\n1,2\n')
assert.ok(!CONTROLS.test(collide), JSON.stringify(collide))
console.log('ok   two headers that sanitize to one name: both quoted without control characters')

// A huge header is cut in the message.
const big = 'H'.repeat(5000)
const long = await refusal(`${big},${big}\n1,2\n`)
assert.ok(long.length < 400, `${long.length} characters`)
assert.ok(long.includes('…'), long.slice(0, 120))
console.log('ok   a 5,000-character header is cut short in the message')
console.log('csv-header-error-controls: all assertions passed')
