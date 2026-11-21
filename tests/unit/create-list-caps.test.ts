// The lists a create request sends, kept once each up to their cap (lib/distinct-items.ts): a hiring table's role
// titles (lib/hiring/input.ts) and an AI visibility table's questions (lib/ai-visibility/input.ts). Duplicates are
// dropped (case ignored, the first spelling kept), and a list past its cap is refused at its first item past it, so
// a request listing many items is answered at once. 50,000 items: the scan this replaces took over 40 s on them
// (it grew with the square of the list), small enough for a revert proof to finish.
import assert from 'node:assert/strict'

let failures = 0
function ok(label: string, fn: () => void) {
  try { fn(); console.log('ok  ', label) } catch (e) { failures++; console.log('FAIL', label, (e as Error).message) }
}

const { DistinctItems } = await import('../../server/src/lib/distinct-items')
const { parseHiringInput } = await import('../../server/src/lib/hiring/input')
const { parseAiVisibilityInput } = await import('../../server/src/lib/ai-visibility/input')
const K = await import('../../server/src/lib/constants')

const MANY = 50_000
const FAST_MS = 200
const distinct = (prefix: string) => Array.from({ length: MANY }, (_, i) => `${prefix} ${i}`)
function timed<T>(fn: () => T): { value: T; ms: number } {
  const t = performance.now()
  const value = fn()
  return { value, ms: performance.now() - t }
}

ok('once each, case ignored, the first spelling kept; past the cap nothing is kept', () => {
  const d = new DistinctItems(3)
  for (const s of ['SDR', 'sdr', 'BDR', 'Sdr', 'AE']) assert.equal(d.add(s), true, s)
  assert.deepEqual(d.items, ['SDR', 'BDR', 'AE'])
  assert.equal(d.add('ae'), true, 'a duplicate at the cap is still dropped, not refused')
  assert.equal(d.add('SE'), false)
  assert.deepEqual(d.items, ['SDR', 'BDR', 'AE'])
})

const tooManyRoles = `Start with at most ${K.HIRING_MAX_ROLES} role titles (you can add rows later).`
ok(`role titles: ${MANY.toLocaleString('en-US')} distinct ones are refused at once, as a list or as lines`, () => {
  for (const roles of [distinct('Role'), distinct('Role').join('\n')]) {
    const { value, ms } = timed(() => parseHiringInput({ roles }))
    assert.equal(value, tooManyRoles)
    assert.ok(ms < FAST_MS, `${Math.round(ms)} ms`)
  }
})

ok('role titles: duplicates dropped, the first spelling kept; the cap counts distinct titles', () => {
  const a = parseHiringInput({ roles: ['SDR', ' sdr ', 'BDR', 'SDR'] })
  assert.ok(typeof a === 'object')
  assert.deepEqual(a.roles, ['SDR', 'BDR'])
  const twenty = Array.from({ length: K.HIRING_MAX_ROLES }, (_, i) => `R${i}`)
  const b = parseHiringInput({ roles: [...twenty, ...twenty.map(r => r.toLowerCase())] })
  assert.ok(typeof b === 'object', String(b))
  assert.deepEqual(b.roles, twenty)
  assert.equal(parseHiringInput({ roles: [...twenty, 'One more'] }), tooManyRoles)
  const same = parseHiringInput({ roles: Array.from({ length: MANY }, () => 'SDR') })
  assert.ok(typeof same === 'object')
  assert.deepEqual(same.roles, ['SDR'])
})

const tooManyQuestions = `Start with at most ${K.AI_VISIBILITY_MAX_QUESTIONS} questions (you can add rows later).`
ok(`questions: ${MANY.toLocaleString('en-US')} distinct ones are refused at once`, () => {
  const { value, ms } = timed(() => parseAiVisibilityInput({ brand: 'Acme', questions: distinct('Question') }))
  assert.equal(value, tooManyQuestions)
  assert.ok(ms < FAST_MS, `${Math.round(ms)} ms`)
})

ok('questions: duplicates dropped, the first spelling kept; the cap counts distinct questions', () => {
  const a = parseAiVisibilityInput({ brand: 'Acme', questions: ['Best CRM?', ' best crm? ', 'Cheapest CRM?'] })
  assert.ok(typeof a === 'object')
  assert.deepEqual(a.questions, ['Best CRM?', 'Cheapest CRM?'])
  const all = Array.from({ length: K.AI_VISIBILITY_MAX_QUESTIONS }, (_, i) => `Q${i}?`)
  const b = parseAiVisibilityInput({ brand: 'Acme', questions: [...all, ...all] })
  assert.ok(typeof b === 'object', String(b))
  assert.equal(b.questions.length, K.AI_VISIBILITY_MAX_QUESTIONS)
  assert.equal(parseAiVisibilityInput({ brand: 'Acme', questions: [...all, 'One more?'] }), tooManyQuestions)
})

if (failures > 0) { console.error(`${failures} create-list-caps assertion(s) failed`); process.exit(1) }
console.log('All create-list-caps assertions passed.')
