// A hiring check after its search starts: waits for the run to be over and
// its roles to be in Roles, then sums them up per company
// (services/hiring-summarize.ts), moving the check's journal on at each stage
// (hiring_checks, migration 061). At boot, a check a restart cut short is
// watched again; nothing here ever starts a search.
import { db } from '../lib/db';
import { HIRING_CHECK_POLL_MS } from '../lib/constants';
import { summarizeHiring } from './hiring-summarize';
import { loadHiringCheck, sheetLive, updateHiringCheck, type HiringRecord } from './hiring-store';

// The search's state: still going, or over (with what to say about it).
export function searchState(userId: string, runId: string): { going: true } | { going: false; added: number;
  problems: string[] } {
  const run = db.prepare(`SELECT status, pause_reason, list_rows_added FROM http_runs WHERE id = ? AND user_id = ?`)
    .get(runId, userId) as { status: string; pause_reason: string | null; list_rows_added: number } | undefined;
  if (!run) return { going: false, added: 0, problems: ['The search\'s run is gone.'] };
  if (run.status === 'pending' || run.status === 'running') return { going: true };
  const items = db.prepare(`SELECT COUNT(*) AS n, IFNULL(SUM(wait_reason IS NULL), 0) AS adding
    FROM enrichment_list_items WHERE run_id = ? AND user_id = ? AND status = 'pending'`)
    .get(runId, userId) as { n: number; adding: number };
  if (items.adding > 0) return { going: true };
  const problems: string[] = [];
  if (run.status === 'paused') {
    problems.push(`The search paused${run.pause_reason ? ` (${run.pause_reason})` : ''}: what it found so far is `
      + 'summed up. Check again to search every row.');
  }
  if (run.status === 'failed' || run.status === 'cancelled') problems.push(`The search ${run.status === 'failed'
    ? 'failed' : 'was cancelled'}: what it found so far is summed up.`);
  if (items.n > 0) problems.push(`Results of ${items.n} search${items.n === 1 ? '' : 'es'} are waiting to be added.`);
  return { going: false, added: run.list_rows_added, problems };
}

const watching = new Set<string>();

// Waits for the check's search, then sums it up. Each look is a short read; the summary runs once.
export function watchHiringCheck(userId: string, id: string): void {
  if (watching.has(id)) return;
  watching.add(id);
  const look = async (): Promise<void> => {
    const c = loadHiringCheck(userId, id);
    if (!c || c.stage === 'done' || c.stage === 'stopped') { watching.delete(id); return; }
    if (c.stage === 'searching') {
      // No run: the check stopped between its record and its run's start (a restart).
      const s = c.run_id ? searchState(userId, c.run_id)
        : { going: false as const, added: 0, problems: ["The search didn't start: check again."] };
      if (s.going) { setTimeout(() => void look(), HIRING_CHECK_POLL_MS).unref(); return; }
      updateHiringCheck(userId, id, { stage: 'summarizing', rolesAdded: s.added, problems: s.problems });
    }
    try {
      await summarizeCheck(userId, id);
    } catch (error) {
      console.error(`Summing up hiring check ${id} stopped:`, error);
      updateHiringCheck(userId, id,
        { stage: 'stopped', problems: [`The summary stopped: ${(error as Error).message}`] });
    }
    watching.delete(id);
  };
  setTimeout(() => void look(), HIRING_CHECK_POLL_MS).unref();
}

async function summarizeCheck(userId: string, id: string): Promise<void> {
  const c = loadHiringCheck(userId, id)!;
  const rec = db.prepare('SELECT * FROM hiring_signals WHERE id = ? AND user_id = ?').get(c.signal_id, userId) as
    HiringRecord | undefined;
  if (!rec || !sheetLive(userId, rec.roles_sheet_id) || !sheetLive(userId, rec.companies_sheet_id)) {
    updateHiringCheck(userId, id, { stage: 'stopped', problems: ['The Roles or Companies sheet is no longer there.'] });
    return;
  }
  const done = await summarizeHiring(userId, { roles: rec.roles_sheet_id!, companies: rec.companies_sheet_id },
    { label: c.label, sinceLabel: c.since_label, runId: c.run_id });
  if ('gone' in done) {
    updateHiringCheck(userId, id, { stage: 'stopped', problems: ['Roles or Companies went to the trash while '
      + 'Companies was summed up: nothing more was written.'] });
    return;
  }
  const searched = c.run_id ? searchState(userId, c.run_id) : null;
  const stopped = !c.run_id || (searched && !searched.going && searched.problems.length > 0);
  updateHiringCheck(userId, id, {
    stage: stopped ? 'stopped' : 'done', companiesNew: done.companiesNew, companiesHiringMore: done.companiesHiringMore,
    problems: done.problems,
  });
}

// At boot: a check a restart cut short waits for its search again (the run
// goes on by itself), then sums up. Nothing is searched here.
export function resumeHiringChecks(): void {
  const going = db.prepare(`SELECT id, user_id FROM hiring_checks WHERE stage IN ('searching', 'summarizing')`)
    .all() as Array<{ id: string; user_id: string }>;
  for (const c of going) watchHiringCheck(c.user_id, c.id);
}
