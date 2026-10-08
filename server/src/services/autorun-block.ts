// What a sort, row delete, transfer or column rename/delete answers when a run
// holds the sheet (409). A run a person started keeps the usual words; a paused
// one names itself, so the person can resume or cancel it ("Cancel it" in the
// grid). A run auto-run started is small and short: the 409 names auto-run and
// the sheet yields (lib/sheet-yield.ts), so no new auto-run starts there for a
// while and the person's retry goes through.
import { db } from '../lib/db';
import { yieldSheetToUser } from '../lib/sheet-yield';
import { autorunBusyMessage } from '../lib/autorun-rules';
import { isEnrichmentConfig } from '../lib/enrich-run-config';

export interface BlockingRun { id: string; kind: 'ai' | 'http'; column: string | null; paused: boolean }
export interface RunBlock { message: string; run: BlockingRun }

interface HttpActive {
  id: string; status: string; master_column_name: string | null; autorun_id: string | null;
  total_rows: number; config: string | null;
}

const kindOf = (config: string | null): 'enrichment' | 'http' => {
  try { return isEnrichmentConfig(JSON.parse(config ?? 'null')) ? 'enrichment' : 'http'; } catch { return 'http'; }
};

// An auto-run run's 409 words, and the sheet yields; null for any other run.
function autorunWords(sheetId: string, r: HttpActive): string | null {
  if (!r.autorun_id) return null;
  yieldSheetToUser(sheetId);
  return autorunBusyMessage(kindOf(r.config), r.master_column_name ?? 'this column', r.total_rows);
}

function pausedWords(column: string | null): string {
  return `The ${column ? `${column} ` : ''}run is paused. Resume it to finish, or cancel it, then try again.`;
}

// The sheet-wide guard. `busy` is the site's usual words for a running run.
export function sheetRunBlock(sheetId: string, userId: string, busy: string): RunBlock | null {
  const http = db.prepare(`SELECT id, status, master_column_name, autorun_id, total_rows, config FROM http_runs
    WHERE sheet_id = ? AND user_id = ? AND status IN ('pending', 'running', 'paused')`)
    .all(sheetId, userId) as HttpActive[];
  const ai = db.prepare(`SELECT id, status, column_name FROM ai_runs
    WHERE sheet_id = ? AND user_id = ? AND status IN ('pending', 'running', 'paused')`)
    .all(sheetId, userId) as Array<{ id: string; status: string; column_name: string }>;
  // A paused auto-run run (a person paused it) won't end by itself: it reads as theirs.
  const manual: BlockingRun[] = [
    ...http.filter(r => !r.autorun_id || r.status === 'paused')
      .map(r => ({ id: r.id, kind: 'http' as const, column: r.master_column_name, paused: r.status === 'paused' })),
    ...ai.map(r => ({ id: r.id, kind: 'ai' as const, column: r.column_name, paused: r.status === 'paused' })),
  ];
  if (manual.length) {
    const paused = manual.find(r => r.paused);
    return paused ? { message: pausedWords(paused.column), run: paused } : { message: busy, run: manual[0] };
  }
  const auto = http.find(r => r.autorun_id);
  if (!auto) return null;
  return {
    message: autorunWords(sheetId, auto)!,
    run: { id: auto.id, kind: 'http', column: auto.master_column_name, paused: false },
  };
}

// For a guard that found one HTTP run on a column: auto-run's words if it is
// an auto-run run (and the sheet yields), else null (the site's own words).
export function autorunRunBlock(runId: string): string | null {
  const r = db.prepare(`SELECT id, sheet_id, status, master_column_name, autorun_id, total_rows, config
    FROM http_runs WHERE id = ?`).get(runId) as (HttpActive & { sheet_id: string }) | undefined;
  return r ? autorunWords(r.sheet_id, r) : null;
}

// A manual run on a column auto-run is filling (the run start's 409), or null.
export function autorunFillingColumn(sheetId: string, userId: string, column: string): string | null {
  const r = db.prepare(`SELECT total_rows FROM http_runs WHERE sheet_id = ? AND user_id = ? AND master_column_name = ?
    AND autorun_id IS NOT NULL AND status IN ('pending', 'running') LIMIT 1`).get(sheetId, userId, column) as
    { total_rows: number } | undefined;
  if (!r) return null;
  const rows = `${r.total_rows.toLocaleString('en-US')} row${r.total_rows === 1 ? '' : 's'}`;
  return `Auto-run is filling ${rows} in this column. Wait a moment or pause auto-run.`;
}
