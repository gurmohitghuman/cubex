// A transform_column pass to its end, as a caller goes on with next_cursor. A call's own limit (about 2 seconds of
// work) counts its waits for the WAL: on Windows and Linux a page first waits for a checkpoint still running, such
// as the closing one the call or job before asked for, and on a disk whose syncs stall that wait can take the call's
// time, before its first page (it answers that it only waited, nothing written) or after one (it stopped at its
// limit). Those two answers are the only ones gone on from; any other comes back as it is. Used where a test checks
// what a pass writes, not how long a call takes. A pass that ended in one call answers as it is; one that took more
// answers the last call's answer with every call's rows added up, and the first call's created_column (only it adds
// the column), so a test comparing the whole answer still checks every field of it.
// caughtUp is for a call whose one answer a test checks (a page's error, a stop on a failing page, the cursor of a
// call stopped after one page, the next call going on): going on from a waited answer would skip what the test is
// there to see.
import transformMod from '../../server/src/services/column-transform'
import type { TransformParams } from '../../server/src/services/column-transform'
import walMod from '../../server/src/lib/wal-checkpointer'
const { TRANSFORM_STOPPED_NOTE, TRANSFORM_WAITED_NOTE, transformColumn } =
  transformMod as typeof import('../../server/src/services/column-transform')
const { checkpointInBackground } = walMod as typeof import('../../server/src/lib/wal-checkpointer')

type Outcome = Awaited<ReturnType<typeof transformColumn>>

// A checkpoint on the worker, answered: the one the call or job before asked for, else a new one. On a slow disk the
// next call would otherwise spend its time waiting for the first, or, the WAL holding nothing uncopied (as after a
// test's own big insert, which SQLite checkpointed in its commit), for the one its first write asks for, so the
// worker starts the WAL over (lib/wal-turn.ts). After it the WAL holds frames not yet copied (the worker's start-over
// write, or what was written since it began), so the call's first write goes ahead at once.
export const caughtUp = async (): Promise<void> => { await checkpointInBackground() }

export async function toTheEnd(uid: string, p: TransformParams, most = 50): Promise<Outcome> {
  const first = await transformColumn(uid, p)
  if (!('ok' in first) || !first.ok.next_cursor) return first
  let updated = first.ok.updated
  let out: Outcome = first
  for (let calls = 1; 'ok' in out && out.ok.next_cursor; calls++) {
    if (out.ok.note !== TRANSFORM_WAITED_NOTE && out.ok.note !== TRANSFORM_STOPPED_NOTE) return out
    if (calls >= most) throw new Error(`the pass never ended in ${most} calls: ${JSON.stringify(out)}`)
    // Going on takes the cursor, never restart (the two are refused together).
    const { restart: _restart, ...same } = p
    out = await transformColumn(uid, { ...same, cursor: out.ok.next_cursor })
    if (!('ok' in out)) return out
    updated += out.ok.updated
  }
  if (!('ok' in out)) return out
  return { ok: { ...out.ok, updated, created_column: first.ok.created_column } }
}
