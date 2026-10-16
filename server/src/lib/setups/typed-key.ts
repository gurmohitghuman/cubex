// A key typed straight into an HTTP step's request (pure): where, or null.
// Found the way a pasted cURL command's keys are (lib/curl/key-detect.ts),
// with each /name that reads a column or a saved key counted as the
// reference it is, plus a user and password written into the URL. A setup
// never holds one: saving refuses it (services/setup-save.ts), so a setup's
// request can be shown and exported without carrying a secret.
import { findKeys, type Draft } from '../curl/key-detect';
import { TEMPLATE_TOKEN_RE } from '../http-request-template';
import type { HttpStep } from './spec';

const USERINFO = /^[a-z][a-z0-9+.-]*:\/\/([^/?#@\s]*)@/i;

export function typedKeyIn(request: HttpStep['request'], resolves: (name: string) => boolean): string | null {
  const braced = (text: string) => text.replace(TEMPLATE_TOKEN_RE,
    (full, brace: string | undefined, slash: string | undefined) =>
      (brace === undefined && slash && resolves(slash) ? `{{${slash}}}` : full));
  const userinfo = USERINFO.exec(request.url)?.[1];
  if (userinfo && braced(userinfo).replace(/\{\{[^{}]*\}\}/g, '').replace(':', '').trim()) {
    return 'user and password in the URL';
  }
  const url = braced(request.url), q = url.indexOf('?');
  const query = q < 0 ? [] : url.slice(q + 1).split('&').filter(Boolean).map(part => {
    const eq = part.indexOf('=');
    return eq < 0 ? { key: part, value: '', bare: true }
      : { key: part.slice(0, eq), value: part.slice(eq + 1), bare: false };
  });
  const draft: Draft = {
    method: request.method, base: q < 0 ? url : url.slice(0, q), query,
    headers: Object.entries(request.headers).map(([name, value]) => ({ name: braced(name), value: braced(value) })),
    ...(request.body ? { body: braced(request.body) } : {}),
  };
  try {
    return findKeys(draft, { resolves, variables: [] }).find(f => f.kind === 'value')?.where ?? null;
  } catch {
    return 'request (it holds too many keys to check)';
  }
}

export const typedKeyMessage = (where: string): string =>
  `A key is typed into its ${where}. Save the key in Settings as an external service key, write {{its name}} in `
  + 'the request instead, then try again: a setup never holds a key.';
