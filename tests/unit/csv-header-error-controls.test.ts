// The duplicate-header refusals of a CSV import (lib/csv-import-parse.ts) quote the header, and the message goes
// into the API answer and the server log (which `cubex logs` prints): no control character (ESC, C1, a line break,
// a direction control) and no more than a set length of it may get there; the header still reads as itself.
// The characters are built from their code points, so this file holds no control character itself.
import assert from 'node:assert/strict'
import parseMod from '../../server/src/lib/csv-import-parse'
const { scanCsvText, CsvHeaderCollisionError } = parseMod as typeof import('../../server/src/lib/csv-import-parse')

const ch = (...codes: number[]) => String.fromCharCode(...codes)
// The direction controls: ALM, LRM, RLM, the embeddings and overrides, and the isolates.
const DIRECTION = new Set([0x061C, 0x200E, 0x200F, 0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2066, 0x2067, 0x2068,
  0x2069])
const hasControl = (s: string) => [...s].some(c => {
  const n = c.charCodeAt(0)
  return n < 0x20 || (n >= 0x7F && n <= 0x9F) || DIRECTION.has(n)
})
// Half of a surrogate pair without its other half.
const hasLoneHalf = (s: string) =>
  [...s].some(c => c.length === 1 && c.charCodeAt(0) >= 0xD800 && c.charCodeAt(0) <= 0xDFFF)
const refusal = async (csv: string): Promise<string> => {
  try { await scanCsvText(csv); } catch (e) {
    assert.ok(e instanceof CsvHeaderCollisionError, String(e))
    return e.message
  }
  throw new Error('not refused')
}

// Two byte-identical headers carrying an ANSI escape, a C1 character and a direction control.
const evil = `Name${ch(0x1B)}[31m${ch(0x85, 0x202E)}evil`
const same = await refusal(`"${evil}","${evil}"\n1,2\n`)
assert.ok(!hasControl(same), JSON.stringify(same))
assert.ok(same.includes('Name[31mevil'), same)
console.log('ok   two columns of one name: no control character in the message, the name still readable')

// Two headers that sanitize to one name: both quoted, cleaned.
const collide = await refusal(`"Total","Total${ch(0x07, 0x85)}"\n1,2\n`)
assert.ok(!hasControl(collide), JSON.stringify(collide))
console.log('ok   two headers that sanitize to one name: both quoted without control characters')

// A huge header is cut in the message.
const big = 'H'.repeat(5000)
const long = await refusal(`${big},${big}\n1,2\n`)
assert.ok(long.length < 400, `${long.length} characters`)
assert.ok(long.includes('…'), long.slice(0, 120))
console.log('ok   a 5,000-character header is cut short in the message')

// A cut that falls inside an emoji leaves the whole emoji out, never half of it.
const emoji = `${'H'.repeat(79)}${String.fromCodePoint(0x1F600)}`
const cut = await refusal(`${emoji},${emoji}\n1,2\n`)
assert.ok(!hasLoneHalf(cut), JSON.stringify(cut))
assert.ok(cut.includes(`"${'H'.repeat(79)}…"`), cut)
console.log('ok   a cut inside an emoji leaves no half of it')
console.log('csv-header-error-controls: all assertions passed')
