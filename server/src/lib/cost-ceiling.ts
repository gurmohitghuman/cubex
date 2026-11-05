// The cost ceiling a run or a setup is checked against before it starts
// (pure): max_cost_usd refuses a start whose estimate's high end is above it,
// or that holds something with no known price unless allow_unpriced is true.
// Without max_cost_usd, allow_unpriced does nothing. An estimate only reports
// the outcome (over_ceiling, ceiling_problem); a start is refused with
// fail 'over_ceiling' (REST 409) and creates nothing. For an AI run the
// ceiling is also its hard spend limit (lib/ai-spend-limit.ts).
import { RUN_SPEND_LIMIT_MAX_USD } from './constants';

// Dollars for people: cents from a cent up, two significant figures below
// ($0.00042), never a real amount rounded away to $0.00.
export const money = (usd: number): string =>
  `$${usd >= 0.01 || usd <= 0 ? usd.toFixed(2) : usd.toLocaleString('en-US', { maximumSignificantDigits: 2 })}`;

// Compared in micro-dollars, so a ceiling and an estimate that print alike are alike.
export const micro = (usd: number): number => Math.round(usd * 1e6);

export interface CeilingArgs { maxCostUsd: number | null; allowUnpriced: boolean }
export interface CeilingNames { max: string; allow: string }
const SNAKE: CeilingNames = { max: 'max_cost_usd', allow: 'allow_unpriced' };
export const CAMEL: CeilingNames = { max: 'maxCostUsd', allow: 'allowUnpriced' };

// A dollar limit as sent (max_cost_usd, spend_limit_usd): null when absent.
export function usdLimitOf(raw: unknown, name: string): { value: number | null } | { error: string } {
  if (raw === undefined || raw === null) return { value: null };
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0 || raw > RUN_SPEND_LIMIT_MAX_USD) {
    return { error: `${name} must be a dollar amount more than $0 and at most `
      + `$${RUN_SPEND_LIMIT_MAX_USD.toLocaleString('en-US')}.` };
  }
  return { value: raw };
}

// true/false, or the text "true"/"false" (an MCP client with a stale tool list).
function flagOf(raw: unknown, name: string): { value: boolean } | { error: string } {
  if (raw === undefined || raw === null) return { value: false };
  if (raw === true || raw === 'true') return { value: true };
  if (raw === false || raw === 'false') return { value: false };
  return { error: `${name} must be true or false.` };
}

export function ceilingArgsOf(maxRaw: unknown, allowRaw: unknown, names: CeilingNames = SNAKE)
  : CeilingArgs | { error: string } {
  const max = usdLimitOf(maxRaw, names.max);
  if ('error' in max) return max;
  const allow = flagOf(allowRaw, names.allow);
  if ('error' in allow) return allow;
  return { maxCostUsd: max.value, allowUnpriced: allow.value };
}

const listOf = (names: string[]): string => {
  const quoted = names.map(n => `"${n}"`);
  return quoted.length > 1 ? `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}` : quoted[0];
};

// Why a start must not go ahead under the ceiling, or null. highUsd: the
// estimate's high end, summed over what has a price; unpriced: what costs
// something with no known price (an AI model, a step, web search).
export function ceilingProblem(
  e: { highUsd: number; unpriced: string[] }, c: CeilingArgs, names: CeilingNames = SNAKE,
): string | null {
  if (c.maxCostUsd === null) return null;
  const parts: string[] = [];
  if (micro(e.highUsd) > micro(c.maxCostUsd)) {
    parts.push(`It could cost up to ${money(e.highUsd)}, more than the ${money(c.maxCostUsd)} ceiling `
      + `(${names.max}). Raise ${names.max}, or run fewer rows.`);
  }
  if (e.unpriced.length > 0 && !c.allowUnpriced) {
    parts.push(`No price is known for ${listOf(e.unpriced)}, so Cubex can't tell whether it stays within the `
      + `${money(c.maxCostUsd)} ceiling. Pass ${names.allow}: true to start it anyway.`);
  }
  return parts.length ? parts.join(' ') : null;
}

// What an estimate answer adds once a ceiling is given (nothing without one).
export function ceilingView(e: { highUsd: number; unpriced: string[] }, c: CeilingArgs, names: CeilingNames = SNAKE)
  : { max_cost_usd?: number; over_ceiling?: boolean; ceiling_problem?: string | null } {
  if (c.maxCostUsd === null) return {};
  const problem = ceilingProblem(e, c, names);
  return { max_cost_usd: c.maxCostUsd, over_ceiling: problem !== null, ceiling_problem: problem };
}
