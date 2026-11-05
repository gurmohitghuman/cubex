// A run's money limits: the ceiling a run or a setup is checked against when
// it starts (lib/cost-ceiling.ts) and an AI run's hard spend limit
// (lib/ai-spend-limit.ts, services/ai-spend-gate.ts).
import { AI_CALL_DEADLINE_MS } from './constants-run-safety';

// max_cost_usd and spend_limit_usd: more than $0 and at most this.
export const RUN_SPEND_LIMIT_MAX_USD = 1_000_000;

// What an AI row's most counts on top of its text, which is counted as one
// token a byte (no tokenizer makes more tokens than bytes): each message's
// framing, and with web tools the tool definitions sent with the call.
export const AI_HOLD_MESSAGE_TOKENS = 16;
export const AI_HOLD_WEB_TOOLS_TOKENS = 1_000;

// Another worker generation's hold on an AI run counts this long after it
// last changed: by then every call it had out has ended (each ends by its
// deadline), so a hold left by a worker that died stops counting.
export const AI_HOLD_GRACE_MS = AI_CALL_DEADLINE_MS + 60_000;

// Stable row ids resolve to positions this many at a time, each chunk bound as
// one JSON value: SQLite takes at most 32,766 bound values in one statement.
export const ROW_ID_RESOLVE_CHUNK = 10_000;
