// An HTTP step as a caller without the 'secrets' scope reads it (waterfall
// setup reads for agents), pure: keys typed into the URL read "…" (as column
// details mask them, lib/column-details.ts), header values and the body read
// "…". Sent back unchanged with its id, such a step gets its stored values
// again, but only while its URL, method and body are the ones it had: a
// masked value never goes to a request the caller chose.
import { maskUrlSecrets } from '../column-details';
import type { HttpChoices } from './config';

type Json = Record<string, unknown>;
export const MASKED = '…';

export function maskHttpStep(c: HttpChoices): { url: string; headers: Record<string, string>; body: string | null } {
  return {
    url: maskUrlSecrets(c.url),
    headers: Object.fromEntries(Object.keys(c.headers).map(k => [k, MASKED])),
    body: c.body === null || c.body === '' ? c.body : MASKED,
  };
}

const hasMask = (v: unknown): boolean => typeof v === 'string' && v.includes(MASKED);

// choices: an agent's HTTP step (its url, headers, body), changed in place;
// prior: the column's step with the same id, if any. Returns an error, or null.
export function restoreMaskedStep(choices: Json, prior: HttpChoices | null, where: string): string | null {
  const headers = choices.headers && typeof choices.headers === 'object' ? choices.headers as Json : {};
  const maskedHeaders = Object.keys(headers).filter(k => headers[k] === MASKED);
  const anyMask = hasMask(choices.url) || maskedHeaders.length > 0 || choices.body === MASKED;
  if (!anyMask) return null;
  const sameRequest = !!prior && (choices.url === prior.url || choices.url === maskUrlSecrets(prior.url))
    && String(choices.method ?? 'GET').toUpperCase() === prior.method.toUpperCase()
    && (choices.body === MASKED || (choices.body ?? null) === (prior.body || null) || choices.body === prior.body);
  if (!prior || !sameRequest) {
    return `${where}: a value reads "${MASKED}" (hidden without the secrets scope). Give it in full, or keep `
      + "the step's id, method, URL and body as they were to keep its stored values.";
  }
  choices.url = prior.url;
  for (const k of maskedHeaders) {
    const stored = Object.entries(prior.headers).find(([name]) => name.toLowerCase() === k.toLowerCase());
    if (!stored) return `${where}: header ${k} reads "${MASKED}" but the step has no such header. Give its value.`;
    headers[k] = stored[1];
  }
  if (choices.body === MASKED) choices.body = prior.body;
  return null;
}
