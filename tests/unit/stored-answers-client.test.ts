// Settings' "Stored answers" words (pure): sizes, "counted … ago", and the
// last prune. Value imports are relative (tsx has no "@/").
import {
  agoText, pruneLine, sizeLine, sizeText,
} from '../../client/src/components/settings/stored-answers-copy'
import type { StoredAnswers } from '../../client/src/utils/api/types-enrich-run'

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}

const now = Date.parse('2026-10-09T12:00:00Z')
const view = (o: Partial<StoredAnswers> = {}): StoredAnswers => ({
  bytes: 1288490189, answers: 12345, countedAt: '2026-10-09T11:55:00Z', counting: false, pruneDays: 90, prune: null,
  ...o,
})

check('bytes', sizeText(1) === '1 byte' && sizeText(900) === '900 bytes')
check('KB with one decimal under 10', sizeText(1536) === '1.5 KB')
check('GB', sizeText(1288490189) === '1.2 GB' && sizeText(50 * 1024 ** 3) === '50 GB')
check('just now', agoText('2026-10-09T11:59:30Z', now) === 'just now')
check('minutes', agoText('2026-10-09T11:55:00Z', now) === '5 minutes ago')
check('one hour', agoText('2026-10-09T11:00:00Z', now) === '1 hour ago')
check('days', agoText('2026-10-05T12:00:00Z', now) === '4 days ago')
check('the size line', sizeLine(view(), now) === '1.2 GB in 12,345 answers, counted 5 minutes ago')
check('counting again keeps the old size',
  sizeLine(view({ counting: true }), now) === '1.2 GB in 12,345 answers, counting again…')
check('first count',
  sizeLine(view({ bytes: null, answers: null, countedAt: null, counting: true }), now) === 'Counting…')
check('none', sizeLine(view({ bytes: 0, answers: 0 }), now) === 'None yet.')
check('no prune yet', pruneLine(view()) === null)
const p = (o: Partial<NonNullable<StoredAnswers['prune']>>) =>
  view({ prune: {
    status: 'done', pruned: 3, startedAt: '2026-10-09T10:00:00Z', endedAt: '2026-10-09T10:01:00Z', ...o,
  } })
check('running', pruneLine(p({ status: 'running', pruned: 1200, endedAt: null }))
  === 'Pruning details older than 90 days… 1,200 answers so far.')
check('done', /^Last prune on .+: details removed from 3 answers\.$/.test(pruneLine(p({}))!))
check('nothing to prune', /nothing older than 90 days had details left\.$/.test(pruneLine(p({ pruned: 0 }))!))
check('failed', pruneLine(p({ status: 'failed' })) === 'The last prune stopped on an error. Try again.')

if (failures) { console.log(`\n${failures} failed`); process.exit(1) }
console.log('\nall passed')
