// Cell data keeps U+0080-U+009F (C1) on every write path, so text read with
// the wrong character set can be repaired later; C0 controls (but tab and
// newline), DEL and the BIDI controls still go. The client's copy strips the
// same way, so an edit shows what the server keeps. Names, descriptions and
// labels drop C1 too (stripControlAndC1Chars).
import assert from 'node:assert/strict'
import safetyMod from '../../server/src/lib/csv-safety'
import webhookMod from '../../server/src/lib/webhook-ingest'
import enrichMod from '../../server/src/lib/enrich-cells'
import formulaMod from '../../server/src/lib/formula/cells'
import sqlRowsMod from '../../server/src/lib/sql-rows'
import descriptionMod from '../../server/src/lib/description-text'
import planeMod from '../../server/src/services/data-plane-shared'
import { stripControlChars as clientStrip } from '../../client/src/lib/utils'
const { stripControlChars, stripControlAndC1Chars } = safetyMod as typeof import('../../server/src/lib/csv-safety')
const { valueToCell } = webhookMod as typeof import('../../server/src/lib/webhook-ingest')
const { cellText } = enrichMod as typeof import('../../server/src/lib/enrich-cells')
const { formulaCell } = formulaMod as typeof import('../../server/src/lib/formula/cells')
const { sanitizeColumnName } = sqlRowsMod as typeof import('../../server/src/lib/sql-rows')
const { cleanDescription } = descriptionMod as typeof import('../../server/src/lib/description-text')
const { normalizeCellValue } = planeMod as typeof import('../../server/src/services/data-plane-shared')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

const ch = (...codes: number[]) => String.fromCharCode(...codes)
const C1_ALL = ch(...Array.from({ length: 32 }, (_, i) => 0x80 + i))
const C0_DROPPED = ch(...Array.from({ length: 32 }, (_, i) => i).filter(c => c !== 0x09 && c !== 0x0A))
const BIDI = ch(0x200E, 0x200F, 0x061C, 0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2066, 0x2067, 0x2068, 0x2069)
const GARBLED = 'FraudFighterâ\u0084¢'

for (const [name, strip] of [['server', stripControlChars], ['client', clientStrip]] as const) {
  assert.equal(strip(`a${C1_ALL}b`), `a${C1_ALL}b`, `${name}: every C1 character is kept`)
  assert.equal(strip(GARBLED), GARBLED, `${name}: a garbled value is kept byte for byte`)
  assert.equal(strip(`a${C0_DROPPED}b`), 'ab', `${name}: C0 controls go`)
  assert.equal(strip('a\tb\nc'), 'a\tb\nc', `${name}: tab and newline stay`)
  assert.equal(strip('a\r\nb'), 'a\nb', `${name}: a carriage return goes`)
  assert.equal(strip('a\u007Fb'), 'ab', `${name}: DEL goes`)
  assert.equal(strip(`a${BIDI}b`), 'ab', `${name}: BIDI controls go`)
  assert.equal(strip('José Łódź 日本語 😀'), 'José Łódź 日本語 😀', `${name}: other text stays`)
  assert.equal(strip(''), '', `${name}: empty stays empty`)
}
// The two copies agree on every code unit up to U+FFFF.
for (let c = 0; c <= 0xFFFF; c++) {
  const s = `x${String.fromCharCode(c)}y`
  if (stripControlChars(s) !== clientStrip(s)) assert.fail(`the copies differ at U+${c.toString(16)}`)
}

// Labels drop C1 too, and everything else the cell stripper drops.
assert.equal(stripControlAndC1Chars(`a${C1_ALL}b`), 'ab')
assert.equal(stripControlAndC1Chars(`a${C0_DROPPED}\u007F${BIDI}\tb\n`), 'a\tb\n')

// Cell writers keep C1: an API write, a webhook value, an HTTP or enrichment
// field, a formula's value.
assert.equal(normalizeCellValue(`${GARBLED}\u0000`), GARBLED)
assert.equal(valueToCell(`${GARBLED}\u0000`, 'text'), GARBLED)
assert.equal(cellText(`${GARBLED}\u0000`), GARBLED)
assert.equal(formulaCell({ ok: true, value: `${GARBLED}\u0007` }), GARBLED)

// Names and descriptions don't.
assert.equal(sanitizeColumnName('Na\u0085me'), 'Name')
assert.deepEqual(cleanDescription('Work\u0084 email', 100), { text: 'Work email' })

console.log('control-chars: all assertions passed')
