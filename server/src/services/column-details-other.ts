// Column details of the columns no run fills: a webhook's columns, and clean,
// formula and lookup columns (their records, as their own views read them).
import { db } from '../lib/db';
import type { ColumnDetail } from '../lib/column-details';
import { sheetCleanView } from './clean-view';
import { sheetFormulaView } from './formula-view';
import { sheetLookupView } from './lookup-view';
import { autoRunPart, type DetailContext } from './column-details-context';

export function describeWebhookColumns(ctx: DetailContext): Map<string, ColumnDetail> {
  const out = new Map<string, ColumnDetail>();
  const sources = db.prepare(
    'SELECT id, name, raw_column_name FROM webhook_sources WHERE sheet_id = ? AND user_id = ?',
  ).all(ctx.sheetId, ctx.userId) as Array<{ id: string; name: string; raw_column_name: string }>;
  const mappingsOf = db.prepare(
    'SELECT column_name, json_path FROM webhook_mappings WHERE source_id = ? AND user_id = ?',
  );
  for (const s of sources) {
    const raw = s.raw_column_name;
    if (ctx.types[raw] === 'webhook-source' && ctx.listed.has(raw)) {
      out.set(raw, { name: raw, kind: 'webhook', role: 'payload', fill: { webhook: s.name } });
    }
    const mappings = mappingsOf.all(s.id, ctx.userId) as Array<{ column_name: string; json_path: string }>;
    for (const m of mappings) {
      if (ctx.types[m.column_name] !== 'webhook-mapped' || !ctx.listed.has(m.column_name)) continue;
      out.set(m.column_name, {
        name: m.column_name, kind: 'webhook', role: 'field', fill: { webhook: s.name, json_path: m.json_path },
      });
    }
  }
  return out;
}

export function describeDerivedColumns(ctx: DetailContext): Map<string, ColumnDetail> {
  const out = new Map<string, ColumnDetail>();
  const columns = [...ctx.columns];
  for (const v of Object.values(sheetCleanView(ctx.sheetId, ctx.userId, columns))) {
    if (ctx.types[v.column] !== 'clean') continue;
    out.set(v.column, {
      name: v.column, kind: 'clean',
      fill: {
        cleaner: v.cleaner, fill_status: v.status,
        ...(typeof v.options.phoneFormat === 'string' ? { phone_format: v.options.phoneFormat } : {}),
        ...(typeof v.options.phoneCountry === 'string' ? { phone_country: v.options.phoneCountry } : {}),
      },
      reads: [v.source], ...autoRunPart(ctx, v.column),
    });
  }
  for (const v of Object.values(sheetFormulaView(ctx.sheetId, ctx.userId, columns))) {
    if (ctx.types[v.column] !== 'formula') continue;
    out.set(v.column, {
      name: v.column, kind: 'formula',
      fill: { formula: ctx.cut(v.column, v.formula), fill_status: v.status },
      reads: v.inputs, ...autoRunPart(ctx, v.column),
    });
  }
  for (const v of Object.values(sheetLookupView(ctx.sheetId, ctx.userId, columns))) {
    if (ctx.types[v.column] !== 'lookup') continue;
    out.set(v.column, {
      name: v.column, kind: 'lookup',
      fill: {
        other_sheet: v.otherSheet, other_sheet_id: v.otherSheetId, match_column: v.matchColumn, match: v.match,
        returns: v.returns,
        ...(v.returns === 'value' ? { return_column: v.returnColumns?.[0] ?? null } : {}),
        ...(v.returns === 'list' ? { return_columns: v.returnColumns ?? 'all' } : {}),
        fill_status: v.status, ...(v.broken ? { broken: v.broken } : {}),
      },
      reads: [v.sourceColumn], ...autoRunPart(ctx, v.column),
    });
  }
  return out;
}
