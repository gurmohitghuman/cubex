// Classify a persisted AI row error into an ACTIONABLE class.
//
// The problem: three very different failures
// read identically to a caller staring at 200 blank cells. A provider
// content-filter kill surfaces as "Connection error. (EPIPE)" — which looks like
// infrastructure and cost a long debugging loop when the real fix was rewording
// the prompt. The messages themselves are already good (see ai-row.ts and
// lib/completion-text.ts); nothing LABELS them, so neither a human nor an agent
// can tell "retry this" from "your prompt is the problem".
//
// This is classification ONLY — deliberately not retry policy:
//   - Auto-retry already exists and is intentionally narrow. services/
//     openrouter-retry.ts retries exactly one signature (pre-response
//     ECONNRESET: nothing generated, nothing billed) because with stream:false a
//     retry can land AFTER the provider already generated and charged. Widening
//     retries to everything this file marks 'retryable' would double-bill. Don't.
//   - Leaked tool-call syntax is already FAILED (not stripped) by
//     completion-text.ts, on purpose: stripping leaves a misleading half-answer
//     in an enrichment cell, which is worse than a visible error.
//
// Pure string classification, no DB and no network, so every branch is
// unit-testable against real captured messages.

export type AiErrorClass =
  // Transient/infrastructure: the same request may well succeed later. Safe for
  // a human or agent to re-run (control_run mode 'errored').
  | 'retryable'
  // The prompt or its content is the problem — refusals, content filters, a
  // model that won't answer this phrasing. Re-running UNCHANGED will fail again
  // and bill again; the fix is editing the prompt.
  | 'prompt_content'
  // The model/provider could not produce usable output for a structural reason
  // (token budget exhausted, unresolved tool call, empty completion). Re-running
  // unchanged usually repeats; the fix is a different model or smaller prompt.
  | 'model_output'
  // Account/config level: missing or rejected credentials, no model selected,
  // quota. A rerun cannot fix it — the user must change a setting.
  | 'configuration'
  // Nothing matched. Deliberately distinct from 'retryable': telling someone to
  // retry an error we don't understand invites a pointless paid re-run.
  | 'unknown';

// Ordered most-specific first. The first match wins, so a message that mentions
// both a filter and a connection is classified by the more actionable one.
// Patterns match the messages actually written by lib/completion-text.ts,
// services/ai-row.ts, and the OpenRouter SDK.
const RULES: ReadonlyArray<{ cls: AiErrorClass; re: RegExp }> = [
  // --- configuration: a rerun is futile until the user changes something -----
  { cls: 'configuration', re: /\bno ai model selected\b|\bmodel is required\b/i },
  { cls: 'configuration', re: /\b(401|403)\b|\bunauthorized\b|\binvalid api key\b|\bno auth credentials\b/i },
  { cls: 'configuration', re: /\binsufficient (?:credits?|funds|balance)\b|\bpayment required\b|\b402\b/i },
  { cls: 'configuration', re: /\bmodel not found\b|\bunknown model\b|\bis not a valid model\b/i },

  // --- prompt_content: the wording is the problem ----------------------------
  { cls: 'prompt_content', re: /\bmodel refused to answer\b|\brefusal\b/i },
  { cls: 'prompt_content', re: /\bcontent filter\b|\bcontent_filter\b|\bblocked by\b|\bflagged\b|\bsafety\b/i },
  { cls: 'prompt_content', re: /\bunknown column reference\b|\[MISSING:/i },
  { cls: 'prompt_content', re: /\bprompt is too long\b|\bcontext length\b|\bmaximum context\b|\btoo many tokens\b/i },

  // --- model_output: the call completed but produced nothing usable ----------
  { cls: 'model_output', re: /\bunresolved tool call\b|\btried to call a tool\b/i },
  { cls: 'model_output', re: /\boutput token limit\b|\bfinish_reason=length\b|\bthinking past the budget\b/i },
  { cls: 'model_output', re: /\bempty response\b|\bno usable text\b|\bonly formatting\b|\bzero.completion\b/i },

  // --- retryable: transport + provider-side transients -----------------------
  // Cause codes appended by ai-row.ts, e.g. "Connection error. (ECONNRESET)".
  { cls: 'retryable', re: /\b(ECONNRESET|EPIPE|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|ECONNABORTED)\b/i },
  { cls: 'retryable', re: /\bconnection error\b|\btimed? ?out\b|\bsocket hang ?up\b|\bnetwork error\b/i },
  { cls: 'retryable', re: /\b429\b|\brate limit(?:ed|s)?\b|\btoo many requests\b|\boverloaded\b/i },
  { cls: 'retryable', re: /\b5\d{2}\b|\bbad gateway\b|\bservice unavailable\b|\binternal server error\b|\bprovider returned\b/i },
  { cls: 'retryable', re: /\btemporarily unavailable\b|\btry again\b|\bupstream error\b/i },
];

// Classify one persisted error_message. Null/blank → 'unknown' (a failed row
// with no message is itself a signal, not a retry candidate).
export function classifyAiError(errorMessage: string | null | undefined): AiErrorClass {
  if (typeof errorMessage !== 'string') return 'unknown';
  const msg = errorMessage.trim();
  if (!msg) return 'unknown';
  for (const rule of RULES) {
    if (rule.re.test(msg)) return rule.cls;
  }
  return 'unknown';
}

// One-line guidance per class, surfaced beside the class so a caller doesn't
// have to know what the label implies. Phrased for whoever reads the tool
// output — an agent deciding its next move, or a human reading a run report.
export const AI_ERROR_CLASS_HINT: Record<AiErrorClass, string> = {
  retryable:
    'Transient. Re-running these rows will likely succeed (control_run action "rerun" mode "errored").',
  prompt_content:
    'The prompt or its wording caused this. Re-running unchanged will fail and bill again — edit the prompt first.',
  model_output:
    'The model produced nothing usable. Try a different model, a smaller prompt, or turn off web search / URL fetching.',
  configuration:
    'An account setting is wrong (API key, credits, or model choice). Fix it in Settings — a rerun cannot.',
  unknown:
    'Unrecognized error. Read error_message directly before re-running; do not assume it is transient.',
};

// Aggregate a page of failures into per-class counts, so a caller can say "180
// retryable, 20 prompt-content" without walking every row itself.
export function summarizeErrorClasses(
  errors: ReadonlyArray<string | null | undefined>,
): Array<{ error_class: AiErrorClass; count: number; hint: string }> {
  const counts = new Map<AiErrorClass, number>();
  for (const e of errors) {
    const cls = classifyAiError(e);
    counts.set(cls, (counts.get(cls) ?? 0) + 1);
  }
  // Descending by count: the dominant failure mode is what the caller acts on.
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([error_class, count]) => ({ error_class, count, hint: AI_ERROR_CLASS_HINT[error_class] }));
}
