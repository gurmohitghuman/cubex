// The formula host waits for its own request's answer (server/src/lib/formula/host.ts). The worker writes the
// number of the request it answered into READY, then wakes the API thread; a busy machine can pause it in between,
// long enough for the API thread to read that answer and send the next request, so the late wake lands in the next
// request's wait before that answer exists. With one flag for every request, that request was taken for
// unanswered: the worker stopped and the formula closed with no answer (ai-visibility-formulas, run 45342985136).
// Forced here, open then run, 20 times: the worker pauses 20 ms before each wake (setFormulaWakePauseForTests),
// and this thread pauses 5 ms after posting each request, so it reads a quick answer before its wake and sends
// the next request at once. Every run answers all its rows, the worker is never stopped, and some requests were
// woken before their answer (else this test forced nothing).
import wt from 'node:worker_threads'
import refsMod from '../../server/src/lib/formula/refs'
import cellsMod from '../../server/src/lib/formula/cells'
import sandboxMod from '../../server/src/lib/formula/sandbox'
import hostMod from '../../server/src/lib/formula/host'
const { compileFormula } = refsMod as typeof import('../../server/src/lib/formula/refs')
const { formulaRow } = cellsMod as typeof import('../../server/src/lib/formula/cells')
const { FormulaSandbox } = sandboxMod as typeof import('../../server/src/lib/formula/sandbox')
const { formulaHost, setFormulaWakePauseForTests } = hostMod as typeof import('../../server/src/lib/formula/host')

let failures = 0
function check(label: string, cond: boolean, got?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, got === undefined ? '' : JSON.stringify(got)) }
}

const WAKE_PAUSE_MS = 20
const POST_PAUSE_MS = 5
setFormulaWakePauseForTests(WAKE_PAUSE_MS)
// This thread late to wait after posting a request (to the worker only: those carry a number).
const post = wt.MessagePort.prototype.postMessage
wt.MessagePort.prototype.postMessage = function (this: wt.MessagePort, message: unknown, transfer?: never) {
  post.call(this, message, transfer)
  if (message && typeof message === 'object' && 'seq' in message) {
    const until = performance.now() + POST_PAUSE_MS
    while (performance.now() < until) { /* busy, as a thread the machine doesn't run */ }
  }
}
// A request woken before its answer waits more than once.
let waits = 0
let wokenEarly = 0
const wait = Atomics.wait
Atomics.wait = ((...a: Parameters<typeof Atomics.wait>) => { waits++; return wait(...a) }) as typeof Atomics.wait
const request = formulaHost.request.bind(formulaHost)
formulaHost.request = (msg, capMs) => {
  waits = 0
  try { return request(msg, capMs) } finally { if (waits > 1) wokenEarly++ }
}

const COLS = ['A', 'B']
const rows = [['x', 'y'], ['ab', 'c'], ['', 'z']]
let gen: number | null = null
const lost: string[] = []
for (let round = 0; round < 20; round++) {
  const compiled = compileFormula(`String({{A}}) + '-' + String({{B}}) + ${round}`, COLS)
  const sb = await FormulaSandbox.open(compiled)
  gen ??= formulaHost.gen
  try {
    const r = sb.runRows(rows.map(cells => formulaRow(cells)), 1000)
    const got = r.outcomes.map(o => (o.ok ? o.value : `ERR ${o.error}`))
    const want = rows.map(([a, b]) => `${a}-${b}${round}`)
    if (r.closed || JSON.stringify(got) !== JSON.stringify(want)) {
      lost.push(`round ${round}: ${r.closed ? 'closed, ' : ''}${JSON.stringify(got)}`)
    }
  } finally { sb.dispose() }
}
check('every run answered all its rows', lost.length === 0, lost)
check('the worker was never stopped', formulaHost.gen === gen, { before: gen, after: formulaHost.gen })
check(`requests woken before their answer, and waited on: ${wokenEarly} of 40`, wokenEarly >= 5, wokenEarly)

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nformula host wake: all passed')
