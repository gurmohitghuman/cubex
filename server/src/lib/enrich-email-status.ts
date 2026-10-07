// Email verification verdicts (pure). treg's verify contract returns `valid`
// (the provider says the mailbox accepts mail) plus the provider's own status
// word, which differs by provider (accept_all, catch_all, catch-all, Risky…),
// so acceptance keys on `valid` and on documented words, and the provider's
// word is always shown as it came.

export type EmailVerdict = 'valid' | 'catch_all' | 'risky' | 'invalid' | 'no_verdict';
export type EmailStrategy = 'safest' | 'balanced' | 'wide';

// Compared with spaces, underscores and hyphens removed: "Accept-All",
// "accept all" and "acceptall" are one word. The words come from treg's 11
// verifier adapters (their `verdicts` maps) and live answers: Kitt says
// "valid-risky" for an address it can't confirm (a catch-all domain).
const VALID = new Set(['valid', 'ok', 'deliverable']);
const RISKY = new Set(['risky', 'unknown', 'unverified', 'webmail', 'disposable', 'abuse', 'donotmail']);
const NOT_CHECKED = new Set(['timeout', 'error', 'unavailable', 'verifying', 'pending', 'retry']);
const squash = (w: string) => w.toLowerCase().replace(/[\s_-]+/g, '');
const isCatchAll = (n: string) => n.includes('catch') || n === 'acceptall';

export function classifyVerify(output: { valid?: unknown; status?: unknown } | null | undefined): { verdict: EmailVerdict; word: string | null } {
  const word = typeof output?.status === 'string' && output.status.trim() ? output.status.trim() : null;
  const n = word ? squash(word) : '';
  // A catch-all or a risky word is never a plain "valid", even if a provider
  // sets the flag: "safest" must not take them.
  if (word && isCatchAll(n)) return { verdict: 'catch_all', word };
  if (word && (RISKY.has(n) || n.includes('risky'))) return { verdict: 'risky', word };
  // treg sets `valid` from the provider's own word; without the flag, the word decides.
  if (output?.valid === true || (output?.valid == null && VALID.has(n))) return { verdict: 'valid', word };
  if (!word || NOT_CHECKED.has(n)) return { verdict: 'no_verdict', word };
  // Invalid, undeliverable and any word we don't know (with `valid` not true):
  // never accepted, shown as it came.
  return { verdict: 'invalid', word };
}

export function acceptedBy(strategy: EmailStrategy, verdict: EmailVerdict): boolean {
  if (verdict === 'valid') return true;
  if (verdict === 'catch_all') return strategy === 'balanced' || strategy === 'wide';
  if (verdict === 'risky') return strategy === 'wide';
  return false;
}

// The "Email status" cell: our word, then the provider's when it differs.
export function statusLabel(verdict: EmailVerdict, word: string | null): string {
  const ours = { valid: 'valid', catch_all: 'catch-all', risky: 'risky', invalid: 'invalid', no_verdict: 'not checked' }[verdict];
  return word && word.toLowerCase() !== ours ? `${ours} (${word})` : ours;
}
