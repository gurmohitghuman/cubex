// One /api/v1 route as the OpenAPI document describes it (document.ts). The
// routes-*.ts files list every route by area; tests/unit/openapi.test.ts checks
// the list against the real v1 router, so a new route without an entry fails.
import { z } from 'zod';
import type { AccessTokenScope } from '../lib/access-token';

export type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

// The document's tags, in order: [name, description].
export const TAGS = {
  account: ['Account', 'Check a token, and read this document.'],
  tables: ['Tables and sheets', 'Tables, their sheets, and a sheet as a whole: read, sort, copy, export.'],
  columns: ['Columns', 'Add, rename, describe, reorder and delete columns.'],
  rows: ['Rows', 'Read, find, add, change and delete rows. Import CSV. Find and remove duplicates.'],
  views: ['Views', 'Saved views: named filters plus hidden columns.'],
  filled: ['Clean, formula and lookup columns', 'Free columns: cleaned values, JavaScript formulas, lookups.'],
  runs: ['Runs', 'Start AI and HTTP API runs, read their status and results, and what runs cost.'],
  control: ['Run control', 'Pause, resume, cancel, rerun and undo runs.'],
  enrich: ['Enrichments', 'treg.to enrichments and waterfall columns: paid data, row by row.'],
  visibility: ['AI visibility', "Tables that check which brands AI engines name for buyers' questions."],
  setups: ['Setups', 'Saved chains of filled columns, used again on other sheets.'],
  versions: ['Setup versions', "A sheet's column setup kept by name, compared and restored."],
  hooks: ['Run webhooks', 'URLs Cubex tells, with a signed POST, when a run finishes.'],
  trash: ['Trash and history', "Deleted rows, sheets, tables and columns, putting them back, and a sheet's history."],
} as const;
export type Tag = keyof typeof TAGS;

export interface PathParam { name: string; description: string; schema: z.ZodType }

export interface RouteDoc {
  method: Method;
  // Relative to /api/v1, OpenAPI style: /sheets/{id}/rows.
  path: string;
  operationId: string;
  // One plain line.
  summary: string;
  tag: Tag;
  // What the route's requireScope asks for. scopeNote: when the body changes it.
  scope: AccessTokenScope;
  scopeNote?: string;
  description?: string;
  // Filled from the path by op(): one entry per {param}.
  params: PathParam[];
  // Each property is one query parameter, or one request header.
  query?: z.ZodObject;
  headers?: z.ZodObject;
  // A JSON body, or a multipart form (the CSV import).
  body?: z.ZodType;
  form?: z.ZodObject;
  // Success and route-specific answers by status; the common errors are added
  // by document.ts. Default: 200 'Success.'
  responses?: Record<number, string>;
  // What a success holds: JSON unless the route streams CSV.
  produces?: Array<'json' | 'csv'>;
  // 404 is listed when the path has a parameter, 409 for every method but GET:
  // notFound adds 404; conflict true adds 409 to a GET, false drops it.
  notFound?: boolean;
  conflict?: boolean;
}

const id = (description: string): z.ZodType => z.string().describe(description);
const name = (description: string): z.ZodType => z.string().describe(`${description} URL-encode it.`);

// What each path parameter is, by the path's first segment and its name.
const PARAMS: Record<string, z.ZodType> = {
  'tables.id': id('The table id.'),
  'tables.tableId': id('The table id.'),
  'tables.sheetId': id('The sheet id.'),
  'sheets.id': id('The sheet id.'),
  'sheets.sourceId': id('The sheet the rows come from.'),
  'sheets.name': name('The column name, exactly as in the sheet.'),
  'sheets.column': name('The waterfall column name.'),
  'sheets.viewId': name('The view id, or its name.'),
  'sheets.setupId': id('The setup id.'),
  'sheets.versionId': id('The setup version id.'),
  'rows.rowId': id('The stable row id.'),
  'ai-runs.id': id('The AI run id.'),
  'http-runs.id': id('The HTTP run id. Enrichment and waterfall runs are HTTP runs.'),
  'setups.setupId': id('The setup id.'),
  'setup-runs.runId': id('The setup run id.'),
  'enrichments.toolId': id('The enrichment tool id, such as treg.people.email.find.'),
  'ai-visibility.id': id("The AI visibility table's id, or its Questions sheet id."),
  'run-webhooks.id': id('The run webhook id.'),
  'trash.id': z.number().int().min(1).describe('The trash id.'),
};

export function pathParams(path: string): PathParam[] {
  const first = path.split('/')[1];
  return [...path.matchAll(/\{([^}]+)\}/g)].map(([, param]) => {
    const schema = PARAMS[`${first}.${param}`];
    if (!schema) throw new Error(`openapi: no description for {${param}} in ${path}`);
    return { name: param, description: schema.description ?? '', schema };
  });
}

// A route entry with its path parameters filled in.
export const op = (doc: Omit<RouteDoc, 'params'>): RouteDoc => ({ ...doc, params: pathParams(doc.path) });
