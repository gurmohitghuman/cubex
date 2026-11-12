// A waterfall step's check (and any formula's text) as a start request sends
// them, parsed strictly (pure): a check is treg's email verify, accepted by
// strategy (safest, balanced or wide) and asking its providers in the order
// and with the skips the step picks, as a find step does, or a formula over
// {{value}} and the inputs. What they mean against the catalog and the inputs
// is checked when the step is built (services/waterfall-build-check.ts).
import { FORMULA_MAX_CHARS } from '../constants-formula';
import { ENRICH_ESTIMATE_MAX_LIST } from '../constants-enrich';
import { strayKey } from '../enrich-agent-args';
import type { CheckChoices } from './config';

type Json = Record<string, unknown>;
type Parsed<T> = { ok: T } | { error: string };
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const bad = (error: string): { error: string } => ({ error });

export const PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

// A find step's or a verify's providerOrder or skipProviders: provider names.
// A name the tool doesn't have asks or skips nobody (lib/enrich-run-config.ts routeFor).
export function providerList(v: unknown, name: string): Parsed<string[]> {
  if (v === undefined || v === null) return { ok: [] };
  if (!Array.isArray(v) || v.length > ENRICH_ESTIMATE_MAX_LIST
    || !v.every(s => typeof s === 'string' && PROVIDER_RE.test(s))) return bad(`${name} must be a list of names.`);
  return { ok: v as string[] };
}

// {{input_key}} refs; checked against the inputs when it's built.
export function formulaText(v: unknown, where: string): Parsed<string> {
  if (typeof v !== 'string' || !v.trim()) return bad(`${where}: write the formula.`);
  if (v.length > FORMULA_MAX_CHARS) return bad(`${where}: a formula is at most ${FORMULA_MAX_CHARS} characters.`);
  return { ok: v.trim() };
}

const ACCEPT = new Set(['safest', 'balanced', 'wide']);

export function parseCheck(v: unknown, where: string): Parsed<CheckChoices | null> {
  if (v === undefined || v === null) return { ok: null };
  const at = `${where}: check`;
  if (!isObj(v)) return bad(`${at} is {kind: "verify", accept} or {kind: "formula", formula}.`);
  if (v.kind === 'verify') {
    const stray = strayKey(v, ['kind', 'accept', 'providerOrder', 'skipProviders'], at);
    if (stray) return bad(stray);
    const accept = v.accept ?? 'safest';
    if (typeof accept !== 'string' || !ACCEPT.has(accept)) return bad(`${at}.accept is safest, balanced or wide.`);
    const order = providerList(v.providerOrder, `${at}.providerOrder`);
    if ('error' in order) return order;
    const skip = providerList(v.skipProviders, `${at}.skipProviders`);
    if ('error' in skip) return skip;
    // Only the lists given: a check saved before it could pick providers reads the same.
    return {
      ok: {
        kind: 'verify', accept: accept as 'safest' | 'balanced' | 'wide',
        ...(order.ok.length ? { providerOrder: order.ok } : {}), ...(skip.ok.length ? { skipProviders: skip.ok } : {}),
      },
    };
  }
  if (v.kind === 'formula') {
    const stray = strayKey(v, ['kind', 'formula'], at);
    if (stray) return bad(stray);
    const text = formulaText(v.formula, at);
    return 'error' in text ? text : { ok: { kind: 'formula', formula: text.ok } };
  }
  return bad(`${at}.kind is verify or formula.`);
}

