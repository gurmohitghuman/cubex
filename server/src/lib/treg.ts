// treg.to account reads: checking a key, the team's balance, and how the team
// would be served for one tool. Tool calls live in treg-call.ts, the catalog in
// treg-catalog.ts. Facts below come from treg's source (superdesigndev/treg):
// only X-Treg-Token authenticates; Authorization is relayed to the provider on
// /call/, so it is never sent.
import { TREG_BASE_URL, TREG_CLIENT_SLUG, TREG_META_TIMEOUT_MS, TREG_TOOL_ID_PATTERN } from './constants';

export interface TregJson<T> { status: number; body: T | null }

// GET a treg JSON route under one abort timeout (headers and body). Throws on a
// network error or timeout so callers can tell "unreachable" from an answer.
export async function tregGetJson<T>(path: string, token?: string): Promise<TregJson<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TREG_META_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { Accept: 'application/json', 'X-Treg-Client': TREG_CLIENT_SLUG };
    if (token) headers['X-Treg-Token'] = token;
    // fetch strips only Authorization/Cookie on a cross-origin redirect, so a
    // redirect would carry X-Treg-Token to another host. treg never redirects
    // these routes: refuse, and the caller treats it as unreachable.
    const res = await fetch(`${TREG_BASE_URL}${path}`, { headers, signal: controller.signal, redirect: 'error' });
    const text = await res.text();
    let body: T | null = null;
    if (text) { try { body = JSON.parse(text) as T; } catch { body = null; } }
    return { status: res.status, body };
  } finally { clearTimeout(timer); }
}

// treg's refusals are {"detail": "<string>"} or {"detail": {"error", "message"}}.
export function tregDetail(body: unknown): string {
  const d = (body as { detail?: unknown } | null)?.detail;
  if (typeof d === 'string') return d;
  if (d && typeof d === 'object') {
    const o = d as { message?: unknown; error?: unknown };
    return String(o.message ?? o.error ?? '');
  }
  return '';
}

export type KeyProblem = 'invalid' | 'personal_token' | 'team_setup' | 'suspended' | 'unreachable' | 'unknown';

export type TregKeyCheck =
  | { ok: true; team: string | null; balanceMicro: number | null; onHoldMicro: number | null }
  | { ok: false; problem: KeyProblem; message: string };

// What a refusal of the key means for the user, in plain words.
export function classifyKeyRefusal(status: number, detail: string): { problem: KeyProblem; message: string } {
  const d = detail.toLowerCase();
  if (status === 400 && d.includes('choose an org')) {
    return { problem: 'personal_token', message: 'This is a personal treg login token. In treg, open your team, then API keys, then Create key, and paste that key here.' };
  }
  if (status === 403 && d.includes('finish team setup')) {
    return { problem: 'team_setup', message: 'Finish setting up your team at treg first, then paste its API key.' };
  }
  if (status === 403 && d.includes('suspended')) {
    return { problem: 'suspended', message: `treg says this account or team is suspended (${detail}).` };
  }
  if (status === 401 || status === 403) {
    return { problem: 'invalid', message: `treg did not accept this key${detail ? ` (${detail})` : ''}. Check that you copied the whole key.` };
  }
  return { problem: 'unknown', message: `treg answered ${status}${detail ? `: ${detail}` : ''}.` };
}

const UNREACHABLE = "Can't reach treg. Check the server's internet connection and try again.";

// Settings "Test Key": /usage/me runs treg's full member check (a rotated key
// passes /auth/me but not /call/), /auth/me names the team and its id, and the
// balance route reads what's left. Balance is best-effort.
export async function checkTregKey(token: string): Promise<TregKeyCheck> {
  try {
    const usage = await tregGetJson<unknown>('/usage/me', token);
    if (usage.status !== 200) return { ok: false, ...classifyKeyRefusal(usage.status, tregDetail(usage.body)) };
    const me = await tregGetJson<{ org_id?: unknown; org?: unknown }>('/auth/me', token);
    if (me.status !== 200 || !me.body) return { ok: false, ...classifyKeyRefusal(me.status, tregDetail(me.body)) };
    const team = typeof me.body.org === 'string' ? me.body.org : null;
    const orgId = me.body.org_id != null ? String(me.body.org_id) : null;
    const balance = orgId ? await readBalance(token, orgId) : null;
    return { ok: true, team, balanceMicro: balance?.balanceMicro ?? null, onHoldMicro: balance?.onHoldMicro ?? null };
  } catch {
    return { ok: false, problem: 'unreachable', message: UNREACHABLE };
  }
}

// The team's balance for the drawer's estimate box: /auth/me gives the team
// id, then its balance. null when treg refuses the key or can't be reached.
export async function readTregBalance(token: string): Promise<{ balanceMicro: number; onHoldMicro: number } | null> {
  try {
    const me = await tregGetJson<{ org_id?: unknown }>('/auth/me', token);
    if (me.status !== 200 || me.body?.org_id == null) return null;
    return await readBalance(token, String(me.body.org_id));
  } catch { return null; }
}

// balance_micro is already net of in-flight holds; holds[] lists them.
async function readBalance(token: string, orgId: string): Promise<{ balanceMicro: number; onHoldMicro: number } | null> {
  try {
    const res = await tregGetJson<{ balance_micro?: unknown; holds?: Array<{ amount_micro?: unknown }> }>(
      `/orgs/${encodeURIComponent(orgId)}/balance?limit=1`, token,
    );
    const b = res.body;
    if (res.status !== 200 || !b || typeof b.balance_micro !== 'number') return null;
    const onHold = Array.isArray(b.holds)
      ? b.holds.reduce((sum, h) => sum + (typeof h?.amount_micro === 'number' ? h.amount_micro : 0), 0) : 0;
    return { balanceMicro: b.balance_micro, onHoldMicro: onHold };
  } catch { return null; }
}

// How the team would be served for one tool (own key, free route, treg's key,
// or a waterfall's per-provider plan). Called once for the tool a user picks.
export interface ToolAccess { tier: string | null; metered: boolean | null; estimatedCostUsd: number | null; plan: unknown[] | null }
export async function readToolAccess(token: string, toolId: string): Promise<ToolAccess | null> {
  if (!TREG_TOOL_ID_PATTERN.test(toolId)) return null;
  try {
    const res = await tregGetJson<Record<string, unknown>>(`/catalog/endpoints/${encodeURIComponent(toolId)}/access`, token);
    if (res.status !== 200 || !res.body) return null;
    const b = res.body;
    return {
      tier: typeof b.tier === 'string' ? b.tier : null,
      metered: typeof b.metered === 'boolean' ? b.metered : null,
      estimatedCostUsd: typeof b.estimated_cost_usd === 'number' ? b.estimated_cost_usd : null,
      plan: Array.isArray(b.plan) ? b.plan : null,
    };
  } catch { return null; }
}
