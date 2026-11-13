// The shape of every refusal /mcp sends, from the 2026-07-28 schema
// (JSONRPCErrorResponse) and its error codes (basic/index):
//   - the id is the request's, or absent: the schema has no null id;
//   - no code from -32000 to -32019, a range new implementations SHOULD NOT use.
// refusal() builds Cubex's own refusals; asTheSpecSays() puts the SDK's in the
// same shape (its 406, 413 and 415 use -32000, and most of its refusals id: null).
import { isJsonContentType, ProtocolErrorCode, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/server';
import { API_V1_MAX_JSON_BYTES } from '../lib/api-v1-constants';

export type RequestId = string | number;

// Each says what went wrong and what to send instead.
export const FORBIDDEN_ORIGIN = 'Forbidden origin: a web page may call /mcp only from this Cubex\'s own address. '
  + 'MCP clients outside a browser send no Origin header.';
export const PARSE_ERROR = 'Parse error: the body is not valid JSON. Send one JSON-RPC request as JSON.';
export const TOO_LARGE =
  `Request body too large: send at most ${API_V1_MAX_JSON_BYTES / (1024 * 1024)} MB per request.`;
export const NOT_JSON = 'Unsupported Media Type: send the request as JSON, with Content-Type: application/json.';
// A JSON body Cubex can't read: a charset that isn't a UTF one (latin1, say), or a
// Content-Encoding other than gzip or deflate. UTF-8 is the one to ask for.
export const NOT_UTF8_JSON =
  'Unsupported Media Type: send the body as UTF-8 JSON, with no Content-Encoding or with gzip or deflate.';
export const METHOD_NOT_ALLOWED = 'Method not allowed: /mcp takes POST only, one JSON-RPC request per POST.';
export const BATCH_REFUSED = 'Invalid Request: JSON-RPC batches are not supported. Send one request per POST.';
export const INTERNAL_ERROR = 'Internal error: Cubex could not answer this request. Send it again; '
  + 'if it keeps failing, the server log has the cause.';

// The id to answer with: a single request's string or number id, else none.
export function requestIdOf(body: unknown): RequestId | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const { id, method } = body as { id?: unknown; method?: unknown };
  if (typeof method !== 'string') return undefined;
  return typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id)) ? id : undefined;
}

export function errorBody(code: number, message: string, id?: RequestId) {
  return { jsonrpc: '2.0' as const, ...(id !== undefined && { id }), error: { code, message } };
}

export function refusal(status: number, code: number, message: string, id?: RequestId): Response {
  return Response.json(errorBody(code, message, id), { status });
}

// Every version Cubex speaks, newest first: 2026-07-28 with _meta, and the
// versions a client reaches with initialize.
const everyVersion = (modernOnes: string[]): string[] =>
  [...new Set([...modernOnes, ...SUPPORTED_PROTOCOL_VERSIONS])].sort().reverse();

const LEGACY_CODE = { lowest: -32019, highest: -32000 };
type Refusal = { id?: unknown; error?: { code?: unknown; message?: unknown; data?: { supported?: unknown } } };

// An SDK refusal (an HTTP error status with one JSON-RPC error), reshaped:
//   - id: null is dropped;
//   - a code from the legacy range becomes Invalid Request (-32600) on a 4xx
//     and Internal error (-32603) on a 5xx; a 4xx keeps its words, they say what
//     to send, and a 5xx gets INTERNAL_ERROR's (the SDK's say only "Internal
//     server error");
//   - an Unsupported protocol version (-32022) lists every version Cubex speaks,
//     since a server MUST list all it supports (basic/versioning); the SDK's
//     lists only those a request with _meta can name.
// Anything else, and every answer with a 2xx status, is passed on untouched.
export async function asTheSpecSays(res: Response): Promise<Response> {
  if (res.status < 400 || !isJsonContentType(res.headers.get('content-type'))) return res;
  const body = await res.clone().json().catch(() => null) as Refusal | null;
  const error = body && typeof body === 'object' && !Array.isArray(body) ? body.error : undefined;
  if (!body || !error || typeof error !== 'object') return res;
  let changed = false;
  if ('id' in body && body.id === null) { delete body.id; changed = true; }
  const code = error.code;
  if (typeof code === 'number' && code >= LEGACY_CODE.lowest && code <= LEGACY_CODE.highest) {
    error.code = res.status >= 500 ? ProtocolErrorCode.InternalError : ProtocolErrorCode.InvalidRequest;
    changed = true;
  }
  if (res.status >= 500 && error.code === ProtocolErrorCode.InternalError && error.message !== INTERNAL_ERROR) {
    error.message = INTERNAL_ERROR;
    changed = true;
  }
  const supported = error.code === ProtocolErrorCode.UnsupportedProtocolVersion ? error.data?.supported : undefined;
  if (Array.isArray(supported) && error.data) { error.data.supported = everyVersion(supported); changed = true; }
  if (!changed) return res;
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  return new Response(JSON.stringify(body), { status: res.status, statusText: res.statusText, headers });
}
