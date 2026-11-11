// The OpenAPI 3.1 document for /api/v1, served at GET /api/v1/openapi.json
// (api-v1.ts). Built from the route list (registry.ts) the first time it's
// asked for, then kept: the routes only change with a new build. Bodies and
// parameters are zod schemas turned into JSON Schema 2020-12, which OpenAPI
// 3.1 uses as it is. Success answers say what they hold in words only.
import { z } from 'zod';
import { API_V1_MAX_JSON_BYTES, API_V1_RATE_PER_MIN } from '../lib/api-v1-constants';
import { apiV1Routes } from './registry';
import { TAGS, type RouteDoc } from './route-doc';

type Json = Record<string, unknown>;

const MB = API_V1_MAX_JSON_BYTES / (1024 * 1024);
// The errors every route can answer, by status: [component name, what it means].
const ERRORS: Record<number, [string, string]> = {
  400: ['BadRequest', 'Invalid JSON, or arguments the route refuses. error says what to fix.'],
  401: ['Unauthorized', 'The access token is missing, malformed, revoked or expired.'],
  403: ['Forbidden', "The token lacks a scope this call needs (error names it), or it's at its spend cap."],
  404: ['NotFound', 'Nothing with that id or name in this account.'],
  409: ['Conflict', 'A conflict: a name already taken, a run already active, the sheet busy with an import or '
    + 'a sort (busy: true, try again shortly), a sheet that changed while you paged, an idempotency key sent '
    + 'before with other arguments, or a start over its cost ceiling (over_ceiling: true, with the estimate).'],
  413: ['PayloadTooLarge', `The JSON body is over ${MB} MB.`],
  429: ['TooManyRequests', `Rate limited: ${API_V1_RATE_PER_MIN} requests a minute per token, or the run-start `
    + 'or sheet-copy limit. Retry-After says when to try again.'],
};
const ERROR_BODY = { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } };

// A zod schema as JSON Schema, the way a client sends it.
export function jsonSchema(schema: z.ZodType): Json {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema, { io: 'input' }) as Json;
  return rest;
}

function parameters(route: RouteDoc): Json[] {
  const out: Json[] = route.params.map(p => {
    const { description: _same, ...schema } = jsonSchema(p.schema);
    return { name: p.name, in: 'path', required: true, description: p.description, schema };
  });
  for (const [where, shape] of [['query', route.query], ['header', route.headers]] as const) {
    if (!shape) continue;
    const object = jsonSchema(shape);
    const required = new Set((object.required as string[] | undefined) ?? []);
    for (const [name, property] of Object.entries(object.properties as Record<string, Json>)) {
      const { description, ...schema } = property;
      out.push({ name, in: where, required: required.has(name), ...(description ? { description } : {}), schema });
    }
  }
  return out;
}

function requestBody(route: RouteDoc): Json | undefined {
  const [type, zod] = route.body ? ['application/json', route.body] : route.form ? ['multipart/form-data', route.form]
    : [null, null];
  if (!type || !zod) return undefined;
  const schema = jsonSchema(zod);
  // Optional when nothing in it is: those routes read a missing body as {}.
  const required = ((schema.required as string[] | undefined) ?? []).length > 0;
  return { required, content: { [type]: { schema } } };
}

function responses(route: RouteDoc): Json {
  const own = { ...(route.responses ?? {}) };
  if (!Object.keys(own).some(status => Number(status) < 300)) own[200] = 'Success.';
  const out: Record<number, Json> = {};
  for (const [status, description] of Object.entries(own)) {
    const media = (route.produces ?? ['json']).map(p => (p === 'csv' ? 'text/csv' : 'application/json'));
    out[Number(status)] = Number(status) < 300
      ? { description, content: Object.fromEntries(media.map(m => [m, {}])) }
      : { description, content: ERROR_BODY };
  }
  const common = [400, 401, 429];
  // Every token holds read (write and run include it), so a read route refuses only when its body asks for more.
  if (route.scope !== 'read' || route.scopeNote) common.push(403);
  if (route.params.length || route.notFound) common.push(404);
  if (route.conflict ?? route.method !== 'get') common.push(409);
  if (route.body) common.push(413);
  for (const status of common) out[status] ??= { $ref: `#/components/responses/${ERRORS[status][0]}` };
  return Object.fromEntries(Object.keys(out).map(Number).sort((a, b) => a - b).map(s => [String(s), out[s]]));
}

function operation(route: RouteDoc): Json {
  const scope = route.scope === 'read' ? 'Needs the `read` scope, which every token has.'
    : `Needs the \`${route.scope}\` scope.`;
  const params = parameters(route);
  const body = requestBody(route);
  return {
    operationId: route.operationId,
    summary: route.summary,
    description: [route.description, route.scopeNote ? `${scope} ${route.scopeNote}` : scope].filter(Boolean)
      .join('\n\n'),
    tags: [TAGS[route.tag][0]],
    'x-cubex-scope': route.scope,
    ...(params.length ? { parameters: params } : {}),
    ...(body ? { requestBody: body } : {}),
    responses: responses(route),
  };
}

const DESCRIPTION = [
  "The token-authenticated API of this Cubex server: tables, sheets, rows, columns, runs and what they cost.",
  'Send an access token (Settings, Agent access, Access tokens) as `Authorization: Bearer cubex_pat_...`. '
    + "A token's scopes decide what it may do: read, write, run and secrets. write and run include read.",
  `Send JSON bodies with \`Content-Type: application/json\`, up to ${MB} MB. Errors are JSON: `
    + '`{"error": "..."}`. Some add unknownColumns, lockedColumns, protectedColumns or busy: true.',
  `Each token may make ${API_V1_RATE_PER_MIN} requests a minute. Every answer carries RateLimit-Limit, `
    + 'RateLimit-Remaining and RateLimit-Reset headers.',
  "Bodies that take an MCP tool's arguments keep the tool's notes, which name other MCP tools. "
    + 'The REST guide says which route does what each tool does.',
].join('\n\n');

function build(): Json {
  const routes = apiV1Routes();
  const paths: Record<string, Json> = {};
  for (const route of routes) (paths[route.path] ??= {})[route.method] = operation(route);
  return {
    openapi: '3.1.0',
    info: {
      title: 'Cubex REST API', version: 'v1', description: DESCRIPTION,
      license: { name: 'AGPL-3.0-only', identifier: 'AGPL-3.0-only' },
    },
    externalDocs: {
      description: 'The REST API guide', url: 'https://github.com/gurmohitghuman/cubex/blob/main/docs/mcp.md#rest-api',
    },
    servers: [{ url: '/api/v1', description: 'This Cubex server' }],
    security: [{ bearerAuth: [] }],
    tags: Object.values(TAGS).map(([name, description]) => ({ name, description })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'An access token: cubex_pat_ and 64 hex digits.' },
      },
      schemas: {
        Error: {
          type: 'object', required: ['error'],
          properties: { error: { type: 'string', description: 'What went wrong.' } },
        },
      },
      responses: Object.fromEntries(Object.values(ERRORS).map(([name, description]) =>
        [name, { description, content: ERROR_BODY }])),
    },
  };
}

let cached: Json | null = null;

export function openApiDocument(): Json {
  cached ??= build();
  return cached;
}
