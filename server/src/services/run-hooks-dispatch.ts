// Sending "run finished" notices (docs/run-webhooks.md), in the API process on a
// timer. Triggers on the run tables (migration 034) queue a run_webhook_events
// row in the same transaction as the run's final status; each sweep turns those
// into one delivery per webhook that should hear it, then sends the deliveries
// that are due, RUN_HOOK_CONCURRENCY at a time, through the SSRF guard
// (lib/outbound-post.ts), signed with the webhook's secret. A failed try is
// tried again later (lib/run-hook-retry.ts) and the last RUN_HOOK_LOG_KEEP
// finished deliveries of each webhook are its log. Nothing here can block or
// fail a run: it only reads what the runs wrote. A delivery cut off by a restart
// is sent again (receivers tell repeats apart by X-Cubex-Delivery).
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { decrypt } from '../lib/crypto';
import { redactSecrets } from '../lib/redact';
import { OutboundBlockedError } from '../lib/http-errors';
import { postGuarded } from '../lib/outbound-post';
import { noticeBody, signRunHookBody, SIGNATURE_HEADER } from '../lib/run-hook-sign';
import { answerProblem, isDelivered, runHookRetryWait } from '../lib/run-hook-retry';
import {
  RUN_HOOK_CONCURRENCY, RUN_HOOK_ERROR_MAX_CHARS, RUN_HOOK_EVENTS_PER_SWEEP, RUN_HOOK_LOG_KEEP,
  RUN_HOOK_MAX_WAITING, RUN_HOOK_SWEEP_MS, RUN_HOOK_TIMEOUT_MS,
} from '../lib/constants-run-hooks';

interface EventRow {
  id: number; user_id: string; run_id: string; kind: 'ai' | 'http' | 'enrichment' | 'setup'; sheet_id: string;
  status: 'completed' | 'failed' | 'cancelled'; webhook_id: string | null; named_only: number; finished_at: string;
}

const nowIso = () => new Date().toISOString();
const short = (message: string) => redactSecrets(message).slice(0, RUN_HOOK_ERROR_MAX_CHARS);

// Finished runs → deliveries, in one transaction (the events read are the ones
// deleted). A plain read first, so an idle sweep never takes the write lock.
export function fanOutRunEvents(now = Date.now()): number {
  if (!db.prepare('SELECT 1 FROM run_webhook_events LIMIT 1').get()) return 0;
  return db.transaction(() => {
    const events = db.prepare('SELECT * FROM run_webhook_events ORDER BY id LIMIT ?')
      .all(RUN_HOOK_EVENTS_PER_SWEEP) as EventRow[];
    if (events.length === 0) return 0;
    const hooksOf = db.prepare(`SELECT id FROM run_webhooks
      WHERE user_id = ? AND ((every_run = 1 AND ? = 0) OR id = ?)`).pluck();
    const waiting = db.prepare(`SELECT COUNT(*) FROM run_webhook_deliveries
      WHERE webhook_id = ? AND state IN ('pending', 'sending')`).pluck();
    const insert = db.prepare(`INSERT INTO run_webhook_deliveries (id, user_id, webhook_id, event, run_id, kind,
      run_status, body, state, next_try_at, error, finished_at)
      VALUES (?, ?, ?, 'run.finished', ?, ?, ?, ?, ?, ?, ?, ?)`);
    const full = new Set<string>();
    for (const e of events) {
      const body = noticeBody({
        event: 'run.finished', run_id: e.run_id, kind: e.kind, sheet_id: e.sheet_id, status: e.status,
        finished_at: e.finished_at,
      });
      for (const hook of hooksOf.all(e.user_id, e.named_only, e.webhook_id) as string[]) {
        const over = (waiting.get(hook) as number) >= RUN_HOOK_MAX_WAITING;
        insert.run(uuidv4(), e.user_id, hook, e.run_id, e.kind, e.status, body, over ? 'failed' : 'pending', now,
          over ? `Not sent: ${RUN_HOOK_MAX_WAITING} notices were already waiting for this URL.` : null,
          over ? nowIso() : null);
        if (over) full.add(hook);
      }
    }
    db.prepare('DELETE FROM run_webhook_events WHERE id <= ?').run(events[events.length - 1].id);
    for (const hook of full) pruneLog(hook);
    return events.length;
  }).immediate();
}

// The log keeps each webhook's newest finished deliveries.
function pruneLog(webhookId: string): void {
  db.prepare(`DELETE FROM run_webhook_deliveries WHERE webhook_id = ? AND state IN ('delivered', 'failed')
    AND id NOT IN (SELECT id FROM run_webhook_deliveries WHERE webhook_id = ? AND state IN ('delivered', 'failed')
      ORDER BY created_at DESC, rowid DESC LIMIT ?)`).run(webhookId, webhookId, RUN_HOOK_LOG_KEEP);
}

interface DeliveryRow {
  id: string; webhook_id: string; event: string; body: string; tries: number; url: string; secret_encrypted: string;
}

type Outcome = { delivered: boolean; code: number | null; error: string | null; retryAfter: string | null;
  final: boolean };

async function tryOnce(d: DeliveryRow): Promise<Outcome> {
  const secret = decrypt(d.secret_encrypted);
  if (!secret) {
    return { delivered: false, code: null, retryAfter: null, final: true,
      error: 'Cubex couldn\'t read this webhook\'s secret. Make a new secret in Settings.' };
  }
  try {
    const answer = await postGuarded(d.url, d.body, {
      'Content-Type': 'application/json', 'User-Agent': 'Cubex-Webhook/1',
      'X-Cubex-Event': d.event, 'X-Cubex-Delivery': d.id, [SIGNATURE_HEADER]: signRunHookBody(secret, d.body),
    }, RUN_HOOK_TIMEOUT_MS);
    if (isDelivered(answer.status)) {
      return { delivered: true, code: answer.status, error: null, retryAfter: null, final: true };
    }
    return { delivered: false, code: answer.status, error: answerProblem(answer.status), retryAfter: answer.retryAfter,
      final: false };
  } catch (error: any) {
    // A blocked URL stays blocked; no answer may be temporary.
    const blocked = error instanceof OutboundBlockedError;
    return { delivered: false, code: null, retryAfter: null, final: blocked,
      error: short(blocked ? `Not sent: ${error.message}` : error?.message || 'The request failed.') };
  }
}

// One try of a claimed ('sending') delivery, and what comes next. once: a test,
// never tried again.
export async function deliver(id: string, once = false): Promise<void> {
  const d = db.prepare(`SELECT d.id, d.webhook_id, d.event, d.body, d.tries, w.url, w.secret_encrypted
    FROM run_webhook_deliveries d JOIN run_webhooks w ON w.id = d.webhook_id WHERE d.id = ?`).get(id) as
    DeliveryRow | undefined;
  if (!d) return; // its webhook was deleted meanwhile
  const out = await tryOnce(d);
  const wait = out.delivered || out.final || once ? null : runHookRetryWait(d.tries, out.retryAfter, Date.now());
  const done = wait === null;
  db.prepare(`UPDATE run_webhook_deliveries SET state = ?, response_code = ?, error = ?, next_try_at = ?,
    finished_at = ? WHERE id = ? AND state = 'sending'`).run(
    out.delivered ? 'delivered' : done ? 'failed' : 'pending', out.code, out.error,
    done ? Date.now() : Date.now() + wait, done ? nowIso() : null, id);
  if (done) pruneLog(d.webhook_id);
}

// pending → sending, counting the try; false when another sweep took it.
export function claimDelivery(id: string): boolean {
  return db.prepare(`UPDATE run_webhook_deliveries SET state = 'sending', tries = tries + 1
    WHERE id = ? AND state = 'pending'`).run(id).changes > 0;
}

// Webhooks with a notice out. One at a time per URL: a receiver that's down
// (each try waiting out the timeout) holds one slot, never every slot.
const busy = new Set<string>();

function sendDue(now = Date.now()): void {
  if (busy.size >= RUN_HOOK_CONCURRENCY) return;
  const hooks = db.prepare(`SELECT webhook_id FROM run_webhook_deliveries WHERE state = 'pending' AND next_try_at <= ?
    GROUP BY webhook_id ORDER BY MIN(next_try_at)`).pluck().all(now) as string[];
  const first = db.prepare(`SELECT id FROM run_webhook_deliveries WHERE webhook_id = ? AND state = 'pending'
    AND next_try_at <= ? ORDER BY next_try_at, rowid LIMIT 1`).pluck();
  for (const hook of hooks) {
    if (busy.size >= RUN_HOOK_CONCURRENCY) return;
    if (busy.has(hook)) continue;
    const id = first.get(hook, now) as string | undefined;
    if (!id || !claimDelivery(id)) continue;
    busy.add(hook);
    deliver(id)
      .catch(err => console.error(`Run webhook delivery ${id} failed to send:`, short(String(err?.message ?? err))))
      .finally(() => busy.delete(hook));
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function runHookSweep(): void {
  try {
    fanOutRunEvents();
    sendDue();
  } catch (err) {
    console.error('Run webhook sweep error:', short(String((err as Error)?.message ?? err)));
  }
}

// Started with the server: deliveries a restart cut off go out again; a test
// cut off is logged as such (it's sent once, while someone waits for it).
export function startRunHookLoop(): void {
  if (timer) return;
  db.prepare(`UPDATE run_webhook_deliveries SET state = 'failed', error = ?, finished_at = ?
    WHERE state = 'sending' AND event = 'test'`).run('Cubex restarted while sending this test.', nowIso());
  db.prepare(`UPDATE run_webhook_deliveries SET state = 'pending' WHERE state = 'sending'`).run();
  timer = setInterval(runHookSweep, RUN_HOOK_SWEEP_MS);
  timer.unref?.();
}
