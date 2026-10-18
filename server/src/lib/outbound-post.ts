// POST a small JSON body to a user-supplied URL through the SSRF guard
// (lib/outbound-guard.ts): http(s) only, the host resolved and every address
// checked before anything is sent, the checked addresses pinned into the
// connection (no second DNS lookup to rebind), no redirects (a 3xx is just an
// answer), and one deadline for the whole try, the lookup included. Run webhooks use it
// (services/run-hooks-dispatch.ts): the second user-supplied outbound path next
// to makeHTTPRequest, guarded the same way. The answer's body is never kept: a
// little of it is read so the connection can close, then it's dropped.
import { request, Agent } from 'undici';
import { checkOutboundUrl, pinnedLookup } from './outbound-guard';
import { NetworkError, OutboundBlockedError } from './http-errors';

export interface PostAnswer { status: number; retryAfter: string | null }

const DRAIN_BYTES = 16 * 1024;

export async function postGuarded(
  url: string, body: string, headers: Record<string, string>, timeoutMs: number,
): Promise<PostAnswer> {
  const late = `No answer within ${Math.round(timeoutMs / 1000)} seconds.`;
  const ends = Date.now() + timeoutMs;
  // A slow resolver can't hold the try past its deadline (the lookup itself
  // can't be stopped; its answer is just no longer waited for).
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = await Promise.race([
    checkOutboundUrl(url),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new NetworkError(late)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
  if (!guard.ok) throw new OutboundBlockedError(guard.reason || 'URL not allowed');
  const left = Math.max(1, ends - Date.now());
  const dispatcher = new Agent({ connect: { lookup: pinnedLookup(guard.addresses || []), timeout: left } });
  const signal = AbortSignal.timeout(left);
  try {
    const res = await request(url, {
      method: 'POST', body, headers, headersTimeout: left, bodyTimeout: left, dispatcher, signal,
    }).catch((error: any) => {
      throw new NetworkError(signal.aborted ? late : error?.message || 'The request failed.');
    });
    let read = 0;
    try {
      for await (const chunk of res.body as AsyncIterable<Buffer>) {
        read += chunk.byteLength;
        if (read > DRAIN_BYTES) { res.body.destroy(); break; }
      }
    } catch { /* the status is what counts */ }
    const after = res.headers['retry-after'];
    return { status: res.statusCode, retryAfter: (Array.isArray(after) ? after[0] : after) ?? null };
  } finally {
    dispatcher.close().catch(() => {});
  }
}
