// Who waits for the spans a stopped run's ⏳ clear told (lib/derived-spans.ts, span-kit.ts has the scene), and
// what wakes the readers. A setup step following F reads "working" while F has a span left, and "done" once F has
// worked it out (services/setup-step-again.ts followProgress). A clear with no run (no journal: every ⏳ emptied,
// and told) kicks the readers with spans on the sheet once, at its end (lib/placeholder-cells.ts); a run's clear
// leaves that to the run's end (lib/run-placeholders.ts).
import assert from 'node:assert/strict'
import { spanKit } from './span-kit'
import againMod from '../../server/src/services/setup-step-again'
import cellsMod from '../../server/src/lib/placeholder-cells'
import kickMod from '../../server/src/lib/autorun-kick'
import followMod from '../../server/src/services/derived-follow'
import entryMod from '../../server/src/services/autorun-entry'
const { followProgress } = againMod as typeof import('../../server/src/services/setup-step-again')
const { clearProcessingPlaceholders } = cellsMod as typeof import('../../server/src/lib/placeholder-cells')
const { onFollowQueued } = kickMod as typeof import('../../server/src/lib/autorun-kick')
const { derivedFollowTick } = followMod as typeof import('../../server/src/services/derived-follow')
const { loadEntry } = entryMod as typeof import('../../server/src/services/autorun-entry')
const k = spanKit('derived-span-wait')
const { db, uid, ok, done, entry, scene, clear, queued, progress, follow } = k
console.error = () => {}

await ok('a setup step following F is working while F has a span left, and done once F has worked it out',
  async () => {
  const { sid, run } = await scene(10)
  // A tick while the clear goes takes the rescan F's save left (services/autorun-fence.ts): only the span is left.
  await clear(sid, run, async slice => {
    if (slice === 1) await derivedFollowTick(loadEntry(entry(sid, 'F'))!)
  })
  const e = loadEntry(entry(sid, 'F'))!
  assert.deepEqual([e.rescan, queued(sid, e.id), progress(sid, 'F')], [0, [], [0]], 'nothing left but the span')
  assert.equal(followProgress(sid, uid, 'formula', 'F'), 'working')
  await follow(sid, ['F'])
  assert.equal(followProgress(sid, uid, 'formula', 'F'), 'done')
})

await ok('a clear with no run kicks the readers with spans once, at its end; F and F2 then end right', async () => {
  // F and F2 were right before the run, which went away without clearing its ⏳ (stopped by a CSV replace).
  const { sid, run, paid } = await scene(10, { before: true })
  db.prepare('UPDATE http_runs SET placeholder_work = NULL WHERE id = ?').run(run.id)
  const told: string[] = []
  const seen: number[] = []
  onFollowQueued(id => { told.push(id) })
  try {
    await clearProcessingPlaceholders(sid, uid, ['Answer'], () => { seen.push(told.length) })
  } finally { onFollowQueued(() => {}) }
  assert.deepEqual([seen, told, progress(sid, 'F')], [[0], [entry(sid, 'F')], [0]],
    'one slice, one span; F told after it, not F2 (it reads F)')
  await follow(sid)
  k.right(sid, paid)
})

done()
