// AI / OpenRouter constants, split out of constants.ts (200-line guardrail).
// Import via './constants' (which re-exports this module) — call sites don't
// need to know about the physical split.

// OpenRouter integration
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_ATTRIBUTION_HEADERS: Record<string, string> = {
  'X-Title': 'Cubex',
};
// There is deliberately NO default AI model constant. Every AI call (columns,
// previews, HTTP-config assist) resolves a USER-chosen model — explicit pick >
// sheet default > account default (lib/ai-model-resolve.ts) — and is rejected
// when none is set. Don't reintroduce a hardcoded fallback.
export const OPENROUTER_MODELS_CACHE_TTL_MS = 5 * 60 * 1000;

// Per-request timeout for an OpenRouter chat completion (one row). The OpenAI SDK
// default is 10 MINUTES — far too long: a hung connection would block a worker slot
// for 10 min. 180s is the backstop for a genuinely stuck connection, sized ABOVE a
// slow reasoning model's legitimate full generation (it can spend the AI_MIN/MAX
// output-token budget thinking) so we don't fail real work — the actual cost guard
// is maxRetries:0 + max_tokens, NOT this timeout. Paired with maxRetries:0 (see
// getOpenRouterClient): chat completions are NOT idempotent, so an auto-retry after a
// (billed, stream:false) generation double-charges the user. Preview rows additionally
// cap at 60s via their own controller (ai-preview-runner.ts); this governs run rows.
export const AI_REQUEST_TIMEOUT_MS = 180_000;
// Set to the default preview size (5) so all preview rows fire in ONE wave
// instead of two (3 + 2): preview latency was (slowest of rows 1-3) + (slowest
// of rows 4-5). 5 parallel OpenRouter calls is trivial vs the MAX_AI_CONCURRENCY
// (100) a full run uses.
export const AI_PREVIEW_CONCURRENCY = 5;
// Ceiling on a persisted preview's serialized results (ai_column_drafts.
// preview_results_json). A pathological preview (20 rows × ~100k-char values)
// would bloat the drafts table; over the cap we keep the CONFIG draft but skip
// persisting results — reuse silently doesn't apply, values are never truncated
// (a truncated value must never be promoted into a cell as if it were complete).
export const AI_DRAFT_MAX_PREVIEW_BYTES = 512 * 1024;
// Per-row output token budget bounds sent to OpenRouter. Reasoning ("thinking")
// models — DeepSeek V4, the o-series, R1, *:thinking variants — spend output
// tokens on internal reasoning BEFORE emitting any final answer. With the old
// 1000-token cap those models routinely hit finish_reason="length" while still
// mid-reasoning and returned message.content === null, which Cubex then wrote as
// a silent blank cell. The FLOOR leaves headroom for the reasoning trace + a
// normal cell-sized answer; a user-supplied max_chars RAISES the budget above
// the floor (chars ≈ tokens for cell-sized text) up to the CEILING, which bounds
// runaway generation latency/cost. See aiMaxTokens() below for the math.
export const AI_MIN_OUTPUT_TOKENS = 8000;
export const AI_MAX_OUTPUT_TOKENS = 16000;

// estimate_only (dry-run cost) tuning. Input tokens are estimated by rendering
// the prompt against a sample of real rows (free — no API calls) and averaging.
// Output tokens are the real variable: we prefer HISTORY (avg -> p75 of this
// model's past completion_tokens, Clay's variable-price mechanism) and fall back
// to a modest typical-cell range only when history is too thin. We deliberately
// do NOT use aiMaxTokens() (8k-16k) as the high bound — that's a reasoning-
// headroom safety cap, not an expected cell size, and would inflate the estimate
// by ~50x.
// Max typed columns one structured AI run may emit. Well under the 80-col sheet
// cap; the start path still enforces the real per-sheet cap atomically.
export const MAX_OUTPUT_COLUMNS_PER_RUN = 20;

// preview_rows: how many rows a run_ai_column dry-preview may actually execute
// (real AI calls) to show sample output + a MEASURED cost before the full run.
export const PREVIEW_MAX_ROWS = 20;

export const AI_ESTIMATE_SAMPLE_ROWS = 50;
export const AI_ESTIMATE_MIN_HISTORY = 20;
export const AI_ESTIMATE_CHARS_PER_TOKEN = 4;
export const AI_ESTIMATE_DEFAULT_OUTPUT_TOKENS_LOW = 100;
export const AI_ESTIMATE_DEFAULT_OUTPUT_TOKENS_HIGH = 600;

// Resolve the OpenRouter max_tokens for one row from an optional user max_chars.
// clamp(maxChars || floor, floor, ceiling): no max_chars → the floor; a small
// max_chars can't starve a reasoning model below the floor; a huge max_chars is
// capped at the ceiling. Shared by the preview runner and the production runner
// so the two never drift. (max_chars also truncates the FINAL text post-gen.)
export function aiMaxTokens(maxChars: number | null | undefined): number {
  const requested = maxChars && maxChars > 0 ? maxChars : AI_MIN_OUTPUT_TOKENS;
  return Math.min(AI_MAX_OUTPUT_TOKENS, Math.max(AI_MIN_OUTPUT_TOKENS, requested));
}
// Backoff before the ONE retry of a pre-response stale-socket ECONNRESET (see
// services/openrouter-retry.ts). Long enough for the keep-alive agent to evict
// the dead socket so the retry dials fresh; short enough to be invisible next
// to a multi-second generation.
export const AI_CONNECT_RETRY_DELAY_MS = 400;
// How long a socket may sit idle in the OpenRouter keep-alive pool before it's
// closed (withIdleLimit in lib/openrouter-agent.ts). An idle connection can be
// dropped upstream (or by a NAT) without the close ever reaching us; a run that
// starts after a quiet spell then gets those dead sockets and fails its whole
// first wave with "Connection error. (EPIPE)". Short enough to beat upstream
// idle timeouts, long enough to keep the pool warm between back-to-back runs.
export const OPENROUTER_IDLE_SOCKET_MS = 30_000;
// Max in-run request fan-out a single AI run may use (the per-row semaphore in
// ai-runner-lifecycle). This is independent of WORKER_POOL_SIZE (concurrent
// RUNS) — it's how many OpenRouter calls ONE run makes in parallel. Paid
// OpenRouter models tolerate ~100; free models rate-limit much lower (the client
// warns past 10). Mirrored in client/src/lib/constants.ts (keep in sync).
export const MAX_AI_CONCURRENCY = 100;
// Fallback fan-out when a run specifies no concurrency AND the sheet has no
// default_ai_concurrency (migration 025). Deliberately conservative: it's the
// value an unconfigured sheet gets, and a free model at 5 is unlikely to
// rate-limit. Callers that want the sheet's setting must go through
// resolveAiConcurrency (lib/ai-model-resolve.ts) — reading this constant
// directly is what pinned MCP/API runs at 5 regardless of the sheet setting.
export const DEFAULT_AI_CONCURRENCY = 5;

// Concurrency below which free OpenRouter models are unlikely to rate-limit.
// The client shows a warning when a FREE model is selected above this.
export const FREE_MODEL_CONCURRENCY_WARN = 10;
// Per-row web-search result caps, passed on the openrouter:web_search tool.
// max_results bounds ONE search (OpenRouter default 5); max_total_results
// bounds the CUMULATIVE results across every search the model decides to run
// for a row — the model, not us, picks the search count, and unbounded it
// averaged 2-4 searches/row in production.
// 10 total ≈ two full searches: enough for verify-style prompts,
// bounded exposure for cost and context. Pricing is engine-dependent (Exa/
// Parallel bill per request/result; native provider search sets its own and
// ignores max_results), so this limits exposure rather than fixing a price.
export const WEB_SEARCH_MAX_RESULTS = 5;
export const WEB_SEARCH_MAX_TOTAL_RESULTS = 10;
