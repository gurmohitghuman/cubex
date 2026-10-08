// What the answer panel lists for an enrichment row (pure): each treg call the
// row made, from the ledger (enrichment_calls, keyed by the stable row id, so
// a sort never shows another row's calls), joined with what Cubex noted about
// its own steps (_cubex.steps: the guess, each find and check), and the
// providers treg tried for the final answer (_treg.tried). Only what treg and
// the ledger recorded; nothing is inferred.
import { displayName } from './enrich-outcome';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max = 300): string | null => (typeof v === 'string' && v ? v.slice(0, max) : null);
const usd = (micro: number | null): number | null => (micro === null ? null : micro / 1e6);

// Who answered, as treg's _treg.tier says: the team's own key (tool or
// credential), a free public route (anonymous), or treg's own key (platform).
// What it cost is the ledger's to say, not this label's.
export type Access = 'own' | 'free' | 'treg';

export function accessOf(tier: string | null): Access | null {
  if (tier === 'anonymous') return 'free';
  if (tier === 'tool' || tier === 'credential') return 'own';
  if (tier === 'platform') return 'treg';
  return null;
}

export interface LedgerRow {
  attempt: string; tool_id: string; call_id: string | null; cost_micro: number | null;
  original_cost_micro: number | null; http_status: number | null; treg_error: string | null;
  served_by: string | null; served_via: string | null; tier: string | null;
  cache_hit: number; replay: number; created_at: string;
}

export interface CallStep {
  attempt: string;
  step: 'guess' | 'find' | 'check' | 'call';
  toolId: string; callId: string | null;
  costUsd: number | null; originalCostUsd: number | null;
  httpStatus: number | null; tregError: string | null;
  servedBy: string | null; servedVia: string | null;
  cached: boolean; replay: boolean; at: string;
  email: string | null;       // the address this step found or checked
  verdict: string | null;     // a check's verdict (valid, invalid, catch_all…), as Cubex classified it
  word: string | null;        // the checker's own word for it
  outcome: string | null;     // a find's outcome (hit, miss, capped)
  alreadyChecked: string | null; // a find that returned an address this row already checked: that verdict
}

export interface TriedProvider {
  provider: string; outcome: string; status: number | null; costUsd: number | null; detail: string | null;
}

const STEP: Record<string, CallStep['step']> = { g: 'guess', f: 'find', v: 'check', t: 'call' };
// "f1", "f1.2" (a new key after a refusal) and "t1r" (a renewed key) are one step.
const baseAttempt = (a: string) => a.replace(/(?:r|\.\d+)+$/, '');

export function callSteps(ledger: LedgerRow[], answer: unknown, providerNames: Record<string, string>): CallStep[] {
  const notes = new Map<string, Json>();
  const cubex = isObj(answer) && isObj(answer._cubex) ? answer._cubex : null;
  for (const s of Array.isArray(cubex?.steps) ? cubex.steps.filter(isObj) : []) {
    if (typeof s.attempt === 'string') notes.set(s.attempt, s);
  }
  return ledger.map(c => {
    const base = baseAttempt(c.attempt);
    const note = notes.get(base) ?? {};
    return {
      attempt: c.attempt, step: STEP[base.charAt(0)] ?? 'call', toolId: c.tool_id, callId: c.call_id,
      costUsd: usd(c.cost_micro), originalCostUsd: usd(c.original_cost_micro),
      httpStatus: c.http_status, tregError: c.treg_error,
      servedBy: displayName(providerNames, c.served_by), servedVia: c.served_via,
      cached: c.cache_hit === 1, replay: c.replay === 1, at: c.created_at,
      email: str(note.email), verdict: str(note.verdict), word: str(note.word), outcome: str(note.outcome),
      alreadyChecked: str(note.already_checked, 40),
    };
  });
}

export function triedProviders(answer: unknown, providerNames: Record<string, string>): TriedProvider[] {
  const t = isObj(answer) && isObj(answer._treg) ? answer._treg : null;
  if (!t || !Array.isArray(t.tried)) return [];
  return t.tried.filter(isObj).slice(0, 100).map(s => ({
    provider: displayName(providerNames, str(s.provider) ?? str(s.endpoint_id)) ?? 'Unknown provider',
    outcome: str(s.outcome, 40) ?? 'unknown',
    status: typeof s.status === 'number' ? s.status : null,
    costUsd: typeof s.charged_micro === 'number' ? s.charged_micro / 1e6 : null,
    detail: str(s.detail),
  }));
}

// Who found it and on what, from the final answer's own _treg. A single
// tool's answer has no _treg, so treg doesn't say which key it ran on.
export function answerSource(answer: unknown): { foundBy: string | null; access: Access | null } {
  const cubex = isObj(answer) && isObj(answer._cubex) ? answer._cubex : null;
  const t = isObj(answer) && isObj(answer._treg) ? answer._treg : null;
  return { foundBy: str(cubex?.found_by, 120), access: accessOf(str(t?.tier, 40)) };
}
