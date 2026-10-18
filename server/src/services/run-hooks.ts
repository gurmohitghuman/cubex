// "Run finished" webhooks as Settings and /api/v1 manage them (one service for
// both): a URL, whether it hears every run or only runs that name it, and a
// signing secret shown once (when made, and when a new one is made) and kept
// encrypted. A URL must pass the SSRF guard to be saved, and is checked again
// on every try (services/run-hooks-dispatch.ts).
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { encrypt } from '../lib/crypto';
import { checkOutboundUrl } from '../lib/outbound-guard';
import { newRunHookSecret, noticeBody } from '../lib/run-hook-sign';
import { RUN_HOOK_LOG_KEEP, RUN_HOOK_MAX_ENDPOINTS, RUN_HOOK_URL_MAX_CHARS } from '../lib/constants-run-hooks';
import { deliver } from './run-hooks-dispatch';

export type HookFail = { fail: 'bad_request' | 'not_found' | 'conflict'; message: string };

export interface RunWebhookView {
  id: string; url: string; every_run: boolean; created_at: string; updated_at: string;
  last_delivery: { state: string; response_code: number | null; error: string | null; created_at: string } | null;
}
export interface DeliveryView {
  id: string; event: string; run_id: string | null; kind: string | null; run_status: string | null;
  state: 'pending' | 'sending' | 'delivered' | 'failed'; tries: number; response_code: number | null;
  error: string | null; created_at: string; finished_at: string | null;
}

const DELIVERY_COLUMNS = `id, event, run_id, kind, run_status, state, tries, response_code, error, created_at,
  finished_at`;

type HookRow = { id: string; url: string; every_run: number; created_at: string; updated_at: string };

function viewOf(r: HookRow): RunWebhookView {
  const last = db.prepare(`SELECT state, response_code, error, created_at FROM run_webhook_deliveries
    WHERE webhook_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(r.id) as RunWebhookView['last_delivery'];
  return { id: r.id, url: r.url, every_run: r.every_run === 1, created_at: r.created_at, updated_at: r.updated_at,
    last_delivery: last ?? null };
}

const rowOf = (userId: string, id: string) => db.prepare(
  'SELECT id, url, every_run, created_at, updated_at FROM run_webhooks WHERE id = ? AND user_id = ?',
).get(id, userId) as HookRow | undefined;

export function listRunWebhooks(userId: string): RunWebhookView[] {
  const rows = db.prepare(`SELECT id, url, every_run, created_at, updated_at FROM run_webhooks WHERE user_id = ?
    ORDER BY created_at, rowid`).all(userId) as HookRow[];
  return rows.map(viewOf);
}

export function getRunWebhook(userId: string, id: string): RunWebhookView | null {
  const r = rowOf(userId, id);
  return r ? viewOf(r) : null;
}

// A URL Cubex may send to: http(s), no user:password, public. A string is why not.
async function urlProblem(raw: unknown): Promise<string | { url: string }> {
  if (typeof raw !== 'string' || !raw.trim()) return 'url is required.';
  const url = raw.trim();
  if (url.length > RUN_HOOK_URL_MAX_CHARS) return `url is longer than ${RUN_HOOK_URL_MAX_CHARS} characters.`;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return 'url must be a full http:// or https:// address.'; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'url must start with http:// or https://.';
  if (parsed.username || parsed.password) {
    return 'url can\'t hold a user name or password. Check the X-Cubex-Signature header instead.';
  }
  const guard = await checkOutboundUrl(url);
  if (!guard.ok) return `Cubex sends notices only to public addresses. ${guard.reason ?? ''}`.trim();
  return { url };
}

const isFlag = (v: unknown): v is boolean => typeof v === 'boolean';

export async function createRunWebhook(
  userId: string, input: { url?: unknown; every_run?: unknown },
): Promise<{ ok: { webhook: RunWebhookView; secret: string } } | HookFail> {
  if (input.every_run !== undefined && !isFlag(input.every_run)) {
    return { fail: 'bad_request', message: 'every_run must be true or false.' };
  }
  const checked = await urlProblem(input.url);
  if (typeof checked === 'string') return { fail: 'bad_request', message: checked };
  const count = db.prepare('SELECT COUNT(*) FROM run_webhooks WHERE user_id = ?').pluck().get(userId) as number;
  if (count >= RUN_HOOK_MAX_ENDPOINTS) {
    return { fail: 'conflict', message: `You can have up to ${RUN_HOOK_MAX_ENDPOINTS} run webhooks. Delete one first.`,
    };
  }
  if (db.prepare('SELECT 1 FROM run_webhooks WHERE user_id = ? AND url = ?').get(userId, checked.url)) {
    return { fail: 'conflict', message: 'That URL is already a run webhook.' };
  }
  const id = uuidv4();
  const secret = newRunHookSecret();
  try {
    db.prepare(`INSERT INTO run_webhooks (id, user_id, url, secret_encrypted, every_run) VALUES (?, ?, ?, ?, ?)`)
      .run(id, userId, checked.url, encrypt(secret), input.every_run === false ? 0 : 1);
  } catch (err) {
    if (/UNIQUE/.test(String((err as Error)?.message))) {
      return { fail: 'conflict', message: 'That URL is already a run webhook.' };
    }
    throw err;
  }
  return { ok: { webhook: getRunWebhook(userId, id)!, secret } };
}

export async function updateRunWebhook(
  userId: string, id: string, input: { url?: unknown; every_run?: unknown },
): Promise<{ ok: RunWebhookView } | HookFail> {
  if (!rowOf(userId, id)) return { fail: 'not_found', message: 'Run webhook not found' };
  if (input.every_run !== undefined && !isFlag(input.every_run)) {
    return { fail: 'bad_request', message: 'every_run must be true or false.' };
  }
  let url: string | null = null;
  if (input.url !== undefined) {
    const checked = await urlProblem(input.url);
    if (typeof checked === 'string') return { fail: 'bad_request', message: checked };
    url = checked.url;
    if (db.prepare('SELECT 1 FROM run_webhooks WHERE user_id = ? AND url = ? AND id != ?').get(userId, url, id)) {
      return { fail: 'conflict', message: 'That URL is already a run webhook.' };
    }
  }
  db.prepare(`UPDATE run_webhooks SET url = COALESCE(?, url), every_run = COALESCE(?, every_run),
    updated_at = datetime('now') WHERE id = ? AND user_id = ?`)
    .run(url, isFlag(input.every_run) ? (input.every_run ? 1 : 0) : null, id, userId);
  return { ok: getRunWebhook(userId, id)! };
}

// A new secret, shown once; the old one stops signing at once.
export function newRunWebhookSecret(userId: string, id: string): { ok: { secret: string } } | HookFail {
  const secret = newRunHookSecret();
  const changed = db.prepare(`UPDATE run_webhooks SET secret_encrypted = ?, updated_at = datetime('now')
    WHERE id = ? AND user_id = ?`).run(encrypt(secret), id, userId).changes;
  return changed ? { ok: { secret } } : { fail: 'not_found', message: 'Run webhook not found' };
}

// Its log and waiting notices go with it; runs that named it just aren't told.
export function deleteRunWebhook(userId: string, id: string): boolean {
  return db.prepare('DELETE FROM run_webhooks WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

export function runWebhookDeliveries(userId: string, id: string): DeliveryView[] | null {
  if (!rowOf(userId, id)) return null;
  return db.prepare(`SELECT ${DELIVERY_COLUMNS} FROM run_webhook_deliveries WHERE webhook_id = ? AND user_id = ?
    ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(id, userId, RUN_HOOK_LOG_KEEP) as DeliveryView[];
}

// A "test" notice sent now, once, signed like the real ones; it lands in the log.
export async function testRunWebhook(userId: string, id: string): Promise<{ ok: DeliveryView } | HookFail> {
  if (!rowOf(userId, id)) return { fail: 'not_found', message: 'Run webhook not found' };
  const deliveryId = uuidv4();
  const body = noticeBody({
    event: 'test', run_id: null, kind: null, sheet_id: null, status: null, finished_at: new Date().toISOString(),
  });
  db.prepare(`INSERT INTO run_webhook_deliveries (id, user_id, webhook_id, event, body, state, tries, next_try_at)
    VALUES (?, ?, ?, 'test', ?, 'sending', 1, ?)`).run(deliveryId, userId, id, body, Date.now());
  await deliver(deliveryId, true);
  const view = db.prepare(`SELECT ${DELIVERY_COLUMNS} FROM run_webhook_deliveries WHERE id = ?`)
    .get(deliveryId) as DeliveryView | undefined;
  return view ? { ok: view } : { fail: 'not_found', message: 'Run webhook not found' };
}
