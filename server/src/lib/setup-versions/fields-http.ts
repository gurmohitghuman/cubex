// An HTTP API, enrichment or waterfall column's setup in words (pure), for
// fields.ts. A row is [field, shown, compared]: what a read token must not
// see is compared but never shown (header values; a request body unless
// `reveal`; a waterfall step's settings, which can hold a request), and a
// shown value that reads the same on both sides says the hidden part differs.
// settingsOf drops what belongs to one run, not to the column: which rows it
// took, a catalog snapshot, "this run only" flags, a dry run, its spend limit
// (rows times the cap, or what auto-run had left that day), and a waterfall's
// caps and built steps (worked out from treg's prices at each start).
import { maskUrlSecrets } from '../column-details';
import type { HttpFill } from './spec';

export type Row = [field: string, shown: string | null, compared?: string | null];
export interface HttpContext { reveal: boolean; sheetName: (id: string) => string | null }

const text = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const yesNo = (b: unknown) => (b ? 'yes' : 'no');
const usd = (v: unknown) => (typeof v === 'number' ? `$${v}` : null);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);

export function settingsOf(config: Record<string, any>): Record<string, any> {
  const c = JSON.parse(JSON.stringify(config ?? {}));
  if (c.enrichment && typeof c.enrichment === 'object') {
    const e = c.enrichment;
    for (const k of ['toolSnapshot', 'providerNames', 'noReuse', 'spendLimitUsd']) delete e[k];
    e.rows = { where: Array.isArray(e.rows?.where) ? e.rows.where : [] };
    // Its request is built from the tool at each start; its inputs and deleted reads are the setup.
    c.requestConfig = { body: c.requestConfig?.body ?? null, goneColumns: c.requestConfig?.goneColumns ?? null };
  }
  if (c.waterfall && typeof c.waterfall === 'object') {
    const w = c.waterfall;
    for (const k of ['rows', 'noReuse', 'dry', 'spendLimitUsd', 'maxCostPerRowUsd', 'tregCapPerRowUsd']) delete w[k];
    for (const s of Array.isArray(w.steps) ? w.steps : []) {
      if (!s || typeof s !== 'object') continue;
      delete s.built;
      if (s.check && typeof s.check === 'object') delete s.check.built;
    }
  }
  return c;
}

// The input map in a request body ({"email": "{{Email}}"}): "email from Email".
function inputWords(body: unknown): string | null {
  try {
    const parsed = JSON.parse(typeof body === 'string' ? body : '{}');
    const out = Object.entries(parsed ?? {}).filter(([, v]) => typeof v === 'string')
      .map(([k, v]) => `${k} from ${String(v).replace(/^\{\{\s*|\s*\}\}$/g, '')}`);
    return out.length ? out.join(', ') : null;
  } catch {
    return null;
  }
}

const OPS: Record<string, string> = {
  eq: 'is', neq: 'is not', contains: 'contains', gt: 'is more than', lt: 'is less than', empty: 'is empty',
  not_empty: 'is not empty',
};
export const conditionWords = (where: Array<{ column: string; op: string; value?: string }>): string | null =>
  (where.length ? where.map(w => `${w.column} ${OPS[w.op] ?? w.op}${w.value ? ` ${w.value}` : ''}`).join(' and ')
    : null);

function enrichmentRows(f: HttpFill, ctx: HttpContext): Row[] {
  const e = f.config.enrichment ?? {};
  const names = (ids: unknown) => list(ids).map(id => e.providerNames?.[id] ?? id).join(', ') || null;
  return [
    ['Tool', text(e.toolName ?? e.toolId)], ['Inputs', inputWords(f.config.requestConfig?.body)],
    ['Providers, in order', names(e.route?.prefer)], ['Skipped providers', names(e.route?.exclude)],
    ['Stop at first match', e.route ? yesNo(e.route.stopAtFirst) : null],
    ['Max cost per row', usd(e.maxCostPerRowUsd)],
    ['Clean domains', yesNo(e.cleanDomains)], ['Always call again', yesNo(e.fresh)],
    ['Conditions', conditionWords(Array.isArray(e.rows?.where) ? e.rows.where : [])],
    ['Fields from answers', list(e.answerFields).join(', ') || null],
    ['Adds rows to', f.destSheetId ? ctx.sheetName(f.destSheetId) ?? 'a sheet deleted since' : null],
  ];
}

function waterfallRows(f: HttpFill): Row[] {
  const w = settingsOf(f.config).waterfall ?? {};
  const steps: any[] = Array.isArray(w.steps) ? w.steps : [];
  return [
    ['Inputs', inputWords(f.config.requestConfig?.body)],
    ['Steps', steps.map(s => s?.label ?? s?.choices?.kind ?? 'step').join(', ') || null],
    ['Step settings', `${steps.length} step${steps.length === 1 ? '' : 's'}`, JSON.stringify(w)],
    ['Always call again', yesNo(w.fresh)],
  ];
}

function requestRows(f: HttpFill, ctx: HttpContext): Row[] {
  const c = f.config, rc = c.requestConfig ?? {};
  const headers = Object.keys(rc.headers ?? {});
  const body = rc.body ? String(rc.body) : null;
  return [
    ['Method', text(rc.method)], ['URL', rc.url ? maskUrlSecrets(String(rc.url)) : null],
    ['Headers', headers.join(', ') || null, headers.length ? JSON.stringify(rc.headers) : null],
    ['Body', body === null ? null : ctx.reveal ? body : 'set', body],
    ['Timeout', text(rc.timeout)], ['Skip empty fields', rc.skipEmpty ? 'yes' : null],
    ['Batch size', text(c.batchSize)], ['Retries', text(c.retries)], ['Retry POST', c.retryPost ? 'yes' : null],
    ['Uses saved API keys', f.allowSecrets ? 'yes' : 'no'],
  ];
}

export function httpRows(f: HttpFill, ctx: HttpContext): Row[] {
  const c = f.config;
  const gone = list(c.requestConfig?.goneColumns);
  const fields = Array.isArray(c.responseMapping)
    ? c.responseMapping.map((m: any) => `${m?.jsonPath} → ${m?.columnName}`).join(', ') || null : null;
  const shared: Row[] = [['Fields', fields], ['Only run if', text(c.runIf)],
    // Columns its request read that were deleted since (lib/column-ref-rename.ts markTemplateColumnGone).
    ['Reads columns that were deleted', gone.join(', ') || null]];
  if (f.mode === 'enrichment') return [...shared, ...enrichmentRows(f, ctx)];
  if (f.mode === 'waterfall') return [...shared, ...waterfallRows(f)];
  return [...shared, ...requestRows(f, ctx)];
}
