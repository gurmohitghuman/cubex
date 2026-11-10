// Shared by the fix_encoding tests (fix-encoding.test.ts, fix-encoding-guards.test.ts): the cleaner, the four
// ways a value gets garbled, and groups that report on their own.
import fixMod from '../../server/src/lib/clean/fix-encoding'
import bytesMod from '../../server/src/lib/clean/fix-encoding-bytes'
import safetyMod from '../../server/src/lib/csv-safety'
export const { fixEncoding, looksGarbled } = fixMod as typeof import('../../server/src/lib/clean/fix-encoding')
export const { hasLeadPair } = bytesMod as typeof import('../../server/src/lib/clean/fix-encoding-bytes')
export const { stripControlChars } = safetyMod as typeof import('../../server/src/lib/csv-safety')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

// A value's UTF-8 read as Latin-1 or as Windows-1252, once or twice.
const utf8 = new TextEncoder()
export const latin1 = (s: string) => Array.from(utf8.encode(s), b => String.fromCharCode(b)).join('')
export const cp1252 = (s: string) => new TextDecoder('windows-1252').decode(utf8.encode(s))
export const FORMS: Array<[string, (s: string) => string]> = [
  ['Latin-1', latin1], ['Windows-1252', cp1252],
  ['twice Latin-1', s => latin1(latin1(s))], ['twice Windows-1252', s => cp1252(cp1252(s))],
]

// Every form of every word that doesn't come back, or whose answer changes when cleaned again.
export const misses = (words: string[]): string[] => words.flatMap(w => FORMS.flatMap(([name, garble]) => {
  const out = fixEncoding(garble(w))
  return [...(out === w ? [] : [`${w} (${name}) gave ${JSON.stringify(out)}`]),
    ...(fixEncoding(out) === out ? [] : [`${w} (${name}): cleaning ${JSON.stringify(out)} again changes it`])]
}))

let failures = 0
export async function group(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).message) }
}
export function finish(name: string) {
  if (failures > 0) { console.error(`${failures} ${name} group(s) failed`); process.exit(1) }
  console.log(`${name}: all assertions passed`)
}
