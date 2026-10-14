// What a waterfall's "every provider failed" refusal says about each provider
// (pure). treg's route_failed lists them in detail.tried ({provider, outcome,
// status, charged_micro, detail: the first 120 characters of the provider's
// answer}). treg keeps a route_failed under the Idempotency-Key only when it
// charged something (its failed waterfalls charge nothing today), so one that
// charged nothing is asked again under the same key and treg runs it again.
type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
// The row's message is cut at 500 characters (enrich-row-write.ts): 3 providers
// at most, the ones that weren't just busy first, so what's cut off is busy too.
const MAX_PROVIDERS = 3;

// A provider's own error body: {detail}, {message}, {error: "…"} or {error: {message}}.
export function providerText(body: unknown): string {
  if (!isObj(body)) return typeof body === 'string' ? body : '';
  const e = body.error;
  const pick = [body.detail, body.message, isObj(e) ? e.message : e].find(v => typeof v === 'string' && v.trim());
  return typeof pick === 'string' ? pick : '';
}

// Busy or down for now: asking again later may work.
export const isTemporaryStatus = (s: number | null): boolean =>
  s === null || s === 408 || s === 425 || s === 429 || s >= 500;

// treg cuts the provider's answer at 120 characters, so JSON may not parse.
function textOf(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let text = raw;
  try { text = providerText(JSON.parse(raw)) || raw; } catch { /* cut off: keep it as sent */ }
  return text.replace(/\s+/g, ' ').trim().replace(/\.$/, '').slice(0, 80);
}

export interface RouteFailure {
  message: string;
  // Nothing charged and every provider that failed was busy or down: worth asking again.
  temporary: boolean;
  rateLimited: boolean;   // one of them answered 429
}

const triedOf = (detail: Json | null): Json[] => (Array.isArray(detail?.tried) ? detail.tried.filter(isObj) : []);

// What the refusal charged: its own total, or what its providers say they charged.
export function routeCharged(detail: Json | null): boolean {
  if (typeof detail?.charged_micro === 'number' && detail.charged_micro > 0) return true;
  return triedOf(detail).some(t => typeof t.charged_micro === 'number' && t.charged_micro > 0);
}

// names: treg's provider ids -> the names the run shows (config.enrichment.providerNames).
export function routeFailure(detail: Json | null, names: Record<string, string> = {}): RouteFailure {
  const failed = triedOf(detail).filter(t => t.outcome === 'error' || t.outcome === 'rejected').map(t => ({
    provider: typeof t.provider === 'string' && t.provider.trim()
      ? (names[t.provider] ?? t.provider).trim().slice(0, 40) : 'a provider',
    status: typeof t.status === 'number' ? t.status : null,
    text: textOf(t.detail),
  }));
  const charged = routeCharged(detail);
  const shown = [...failed].sort((a, b) => Number(isTemporaryStatus(a.status)) - Number(isTemporaryStatus(b.status)));
  const parts = shown.slice(0, MAX_PROVIDERS).map(f => (f.status === null
    ? `${f.provider} gave no answer${f.text ? `: ${f.text}` : ''}`
    : `${f.provider} answered ${f.status}${f.text ? `: ${f.text}` : ''}`));
  const hidden = shown.slice(MAX_PROVIDERS);
  if (hidden.length) {
    parts.push(`${hidden.length} more${hidden.every(f => isTemporaryStatus(f.status)) ? ' busy or down' : ''}`);
  }
  const head = `Every provider failed for this row${charged ? '' : ' (not charged)'}`;
  return {
    message: parts.length ? `${head}: ${parts.join('; ')}.` : `${head}.`,
    temporary: !charged && failed.length > 0 && failed.every(f => isTemporaryStatus(f.status)),
    rateLimited: failed.some(f => f.status === 429),
  };
}
