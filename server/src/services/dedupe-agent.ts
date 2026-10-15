// remove_duplicates for agents: MCP and POST /api/v1/sheets/:id/remove-duplicates
// call this one function. dry_run defaults to TRUE: removed rows can't be
// brought back, and an agent client may approve tools on its own, so a removal
// takes an explicit dry_run: false (the app's confirm button, for agents).
import { strayKey } from '../lib/enrich-agent-args';
import { flagOf } from '../lib/enrich-agent-input';
import { checkDuplicates } from './dedupe-check';
import { removeDuplicates, type DedupeFail } from './dedupe-remove';
import type { DedupeReport, SampleGroup } from './dedupe-report';

export interface AgentDedupeArgs { columns?: unknown; keep?: unknown; dry_run?: unknown }
const KNOWN = ['columns', 'keep', 'dry_run'];

// Whether the call is a dry run (true unless dry_run is false), or 'invalid'.
export function dedupeDryRun(v: unknown): boolean | 'invalid' {
  const flag = flagOf(v);
  return flag === 'invalid' ? flag : flag !== false;
}

const groupJson = (g: SampleGroup) => ({ kept: g.kept, removed: g.removed, group_size: g.size });

function reportJson(r: DedupeReport) {
  return {
    columns: r.keys.map(k => ({
      column: k.column, match: k.match, ...(k.country ? { phone_country: k.country } : {}),
    })),
    keep: r.keep,
    rows_checked: r.rowsChecked,
    duplicate_groups: r.groups,
    rows_with_empty_key: r.emptyKeyRows,
    samples: r.samples.map(groupJson),
    ...(r.largest ? { largest_group: groupJson(r.largest) } : {}),
  };
}

export async function agentRemoveDuplicates(
  userId: string, sheetId: string, a: AgentDedupeArgs,
): Promise<{ ok: Record<string, unknown> } | DedupeFail> {
  const stray = strayKey(a as Record<string, unknown>, KNOWN, '');
  if (stray) return { fail: 'bad_request', message: `${stray} Nothing was changed.` };
  const dry = dedupeDryRun(a.dry_run);
  if (dry === 'invalid') return { fail: 'bad_request', message: 'dry_run must be true or false.' };
  if (dry) {
    const out = await checkDuplicates(userId, sheetId, a);
    if ('fail' in out) return out;
    const r = out.ok;
    return {
      ok: {
        dry_run: true, ...reportJson(r),
        rows_to_remove: r.duplicateRows, rows_left: r.rowsChecked - r.duplicateRows,
        ...(r.blockedBy ? { blocked_by_run: r.blockedBy.message } : {}),
        note: r.duplicateRows === 0 ? 'No duplicates: nothing to remove.'
          : 'Nothing was removed. Call again with dry_run: false to remove these rows; removed rows are deleted '
            + 'for good, with their AI and HTTP results.',
      },
    };
  }
  const out = await removeDuplicates(userId, sheetId, a);
  if ('fail' in out) return out;
  const r = out.ok;
  return { ok: { dry_run: false, ...reportJson(r), rows_removed: r.removed, rows_left: r.rowsLeft } };
}
