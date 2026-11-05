// Saved API keys by name and where each is used, for agents (MCP
// list_saved_keys and GET /api/v1/saved-keys, 'read' scope). Never a value, a
// masked value, its length or its hash: the value column isn't even read.
// Where: a live sheet's HTTP API, enrichment or waterfall column whose setup
// (its newest run, the one reruns, auto-run and get_sheet use) names the key
// in its URL, headers or body, by the rule the 'secrets' scope check uses
// (lib/http-secrets-scan.ts); and the saved setups that name it. One index
// seek per listed column (idx_http_runs_sheet_column_time), so a column's
// older runs, however many, are never read; rows never are. Sheets and tables
// in the trash are left out.
import { db } from '../lib/db';
import { SAVED_KEY_USES_LISTED } from '../lib/api-v1-constants';
import { savedKeyMatcher } from '../lib/http-secrets-scan';
import { isWaterfallConfig, requestConfigsOfRun } from '../lib/waterfall/config';
import { isEnrichmentConfig } from '../lib/enrich-run-config';
import type { RunFail } from './run-shared';

export interface SavedKeyUse {
  sheet_id: string; sheet_name: string; table_id: string; table_name: string;
  column: string; kind: 'http' | 'enrichment' | 'waterfall'; auto_run: boolean;
}
export interface SavedKeyView {
  name: string; created_at: string; updated_at: string;
  used_in: SavedKeyUse[]; used_in_count: number;
  setups: Array<{ setup_id: string; name: string }>; setups_count: number;
}

interface SheetRow { id: string; name: string; column_order: string | null; table_id: string; table_name: string }

const columnsOf = (raw: string | null): string[] => {
  try {
    const parsed = JSON.parse(raw ?? '[]');
    return Array.isArray(parsed) ? [...new Set(parsed.filter((c): c is string => typeof c === 'string'))] : [];
  } catch { return []; }
};

// Every live column that names a saved key: key name → its uses, in sheet order.
function columnUses(userId: string, names: string[]): Map<string, SavedKeyUse[]> {
  const out = new Map<string, SavedKeyUse[]>(names.map(n => [n, []]));
  const reads = savedKeyMatcher(names);
  const sheets = db.prepare(`SELECT s.id, s.name, s.column_order, t.id AS table_id, t.name AS table_name
    FROM sheets s JOIN tables t ON t.id = s.table_id AND t.user_id = s.user_id
    WHERE s.user_id = ? AND s.trash_id IS NULL AND t.trash_id IS NULL
    ORDER BY t.created_at, t.id, s.position, s.id`).all(userId) as SheetRow[];
  const newest = db.prepare(`SELECT config FROM http_runs WHERE sheet_id = ? AND user_id = ?
    AND master_column_name = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).pluck();
  const autoRun = db.prepare(`SELECT status_column FROM autorun_columns
    WHERE sheet_id = ? AND user_id = ? AND enabled = 1`).pluck();
  for (const sheet of sheets) {
    const on = new Set(autoRun.all(sheet.id, userId) as string[]);
    for (const column of columnsOf(sheet.column_order)) {
      const raw = newest.get(sheet.id, userId, column) as string | null | undefined;
      if (!raw) continue;
      let config: unknown;
      try { config = JSON.parse(raw); } catch { continue; }
      const named = new Set(requestConfigsOfRun(config).flatMap(rc => reads(rc)));
      if (named.size === 0) continue;
      const kind = isWaterfallConfig(config) ? 'waterfall' : isEnrichmentConfig(config) ? 'enrichment' : 'http';
      for (const name of named) {
        out.get(name)?.push({
          sheet_id: sheet.id, sheet_name: sheet.name, table_id: sheet.table_id, table_name: sheet.table_name,
          column, kind, auto_run: on.has(column),
        });
      }
    }
  }
  return out;
}

// Saved setups whose requests name the key (lib/setups/spec.ts keeps names only).
function setupUses(userId: string): Array<{ setup_id: string; name: string; keys: string[] }> {
  const rows = db.prepare(`SELECT id, name, json_extract(spec, '$.keys') AS keys FROM setups
    WHERE user_id = ? AND json_valid(spec) ORDER BY name`).all(userId) as
    Array<{ id: string; name: string; keys: string | null }>;
  return rows.map(r => {
    let keys: unknown = [];
    try { keys = JSON.parse(r.keys ?? '[]'); } catch { /* none */ }
    return { setup_id: r.id, name: r.name, keys: Array.isArray(keys) ? keys.filter(k => typeof k === 'string') : [] };
  });
}

// name: just that key (any case); none such is not_found.
export function listSavedKeys(userId: string, name?: string): { ok: { keys: SavedKeyView[] } } | RunFail {
  const all = db.prepare('SELECT name, created_at, updated_at FROM api_keys WHERE user_id = ? ORDER BY name')
    .all(userId) as Array<{ name: string; created_at: string; updated_at: string }>;
  const wanted = name === undefined ? all : all.filter(k => k.name.toLowerCase() === name.toLowerCase());
  if (name !== undefined && wanted.length === 0) {
    return { fail: 'not_found', message: `There's no saved key named "${name.slice(0, 64)}".` };
  }
  if (wanted.length === 0) return { ok: { keys: [] } };
  // Every name goes to the matcher, so a token resolves to the key it would read.
  const uses = columnUses(userId, all.map(k => k.name));
  const setups = setupUses(userId);
  return {
    ok: {
      keys: wanted.map(k => {
        const used = uses.get(k.name) ?? [];
        const inSetups = setups.filter(s => s.keys.includes(k.name)).map(s => ({ setup_id: s.setup_id, name: s.name }));
        return {
          name: k.name, created_at: k.created_at, updated_at: k.updated_at,
          used_in: used.slice(0, SAVED_KEY_USES_LISTED), used_in_count: used.length,
          setups: inSetups.slice(0, SAVED_KEY_USES_LISTED), setups_count: inSetups.length,
        };
      }),
    },
  };
}
