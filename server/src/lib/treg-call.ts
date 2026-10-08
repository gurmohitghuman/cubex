// One treg tool call (POST/GET /call/<toolId>). The host is fixed: the base
// URL is TREG_BASE_URL (an operator setting, never user input) and the path is
// built from the tool id, never from a stored request URL. Only X-Treg-Token
// authenticates; Authorization is never sent because treg relays it to the
// provider (infra/upstream/relay.py). Never logs the key or row values.
import {
  TREG_BASE_URL, TREG_CLIENT_SLUG, TREG_CALL_TIMEOUT_MS, TREG_ROUTED_CALL_TIMEOUT_MS, TREG_MAX_RESPONSE_BYTES,
} from './constants';
import { readBoundedBody } from './http-body-read';
import { readTregMeta, type TregMeta } from './treg-meta';

export interface TregCallRequest {
  method: string;
  path: string;               // /call/<encoded tool id>, from buildRequest
  query: string;
  body: string | null;
  idempotencyKey: string;
  routed: boolean;            // a waterfall: the route headers apply, and a longer clock
  maxCostUsd: number | null;  // X-Treg-Route-Max-Cost; null only for a tool with no known price
  prefer?: string[];
  exclude?: string[];
  stopAtFirst?: boolean;
  fresh?: boolean;            // skip treg's archive (Cache-Control: no-cache)
}

export interface TregCallAnswer {
  status: number | null;      // null: no answer (network error, timeout)
  body: unknown;              // parsed JSON, the raw text when it isn't JSON, or null
  meta: TregMeta;
  oversize?: boolean;         // the answer passed treg's own 8 MB limit and wasn't read
  incomplete?: boolean;       // headers came, the body was cut off (timeout, reset)
}

const NO_META = readTregMeta({});

export function tregCallHeaders(token: string, r: TregCallRequest, base64 = false): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/json',
    'X-Treg-Client': TREG_CLIENT_SLUG,
    'X-Treg-Token': token,
    'Idempotency-Key': r.idempotencyKey,
  };
  if (r.body !== null) h['Content-Type'] = 'application/json';
  if (base64) h['X-Treg-Body-Encoding'] = 'base64';
  if (r.maxCostUsd !== null) h['X-Treg-Route-Max-Cost'] = Math.max(0, r.maxCostUsd).toFixed(6);
  if (r.routed) {
    if (r.prefer?.length) h['X-Treg-Route-Prefer'] = r.prefer.join(',');
    if (r.exclude?.length) h['X-Treg-Route-Exclude'] = r.exclude.join(',');
    if (r.stopAtFirst) h['X-Treg-Route-Waterfall'] = '0';
  }
  if (r.fresh) h['Cache-Control'] = 'no-cache';
  return h;
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text.slice(0, 4000); }
}

async function send(token: string, r: TregCallRequest, base64: boolean, signal?: AbortSignal): Promise<TregCallAnswer> {
  const timeout = AbortSignal.timeout(r.routed ? TREG_ROUTED_CALL_TIMEOUT_MS : TREG_CALL_TIMEOUT_MS);
  const all = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const url = `${TREG_BASE_URL}${r.path}${r.query ? `?${r.query}` : ''}`;
  const body = r.body === null ? undefined : base64 ? Buffer.from(r.body, 'utf8').toString('base64') : r.body;
  try {
    // fetch strips only Authorization/Cookie on a cross-origin redirect, and
    // treg never redirects /call/, so a redirect is refused (no answer).
    const res = await fetch(url, { method: r.method, headers: tregCallHeaders(token, r, base64), body, signal: all, redirect: 'error' });
    const meta = readTregMeta(res.headers);
    if (!res.body) return { status: res.status, body: null, meta };
    try {
      return { status: res.status, body: parseBody(await readBoundedBody(res.body as unknown as AsyncIterable<unknown>, TREG_MAX_RESPONSE_BYTES)), meta };
    } catch (error) {
      if (signal?.aborted) throw error;
      // Headers arrived (so did the charge, if any): the body was over the cap,
      // or the read was cut off.
      const tooBig = error instanceof Error && error.message.startsWith('Response exceeds');
      return { status: res.status, body: null, meta, ...(tooBig ? { oversize: true } : { incomplete: true }) };
    }
  } catch (error) {
    // The run was stopped: let the caller drop the row. Any other failure
    // (network, DNS, timeout, refused redirect) is "no answer".
    if (signal?.aborted) throw error;
    return { status: null, body: null, meta: NO_META };
  }
}

// A 403 without a call id came from an edge firewall that disliked the body,
// not from treg: send it once more base64-encoded (treg's documented
// workaround, llms.txt). The same Idempotency-Key, since treg never saw it.
export async function tregCall(token: string, r: TregCallRequest, signal?: AbortSignal): Promise<TregCallAnswer> {
  const first = await send(token, r, false, signal);
  if (first.status === 403 && !first.meta.callId && r.body !== null) return send(token, r, true, signal);
  return first;
}
