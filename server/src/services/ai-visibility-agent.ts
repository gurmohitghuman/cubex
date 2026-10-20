// AI visibility tables for agents: the answers /api/v1 and the MCP tool give
// (snake_case), over the same services as the app. Asking the engines is paid:
// each start takes the token's run-start slot and stops at its spend cap.
import { parseAiVisibilityInput, parseBrands } from '../lib/ai-visibility/input';
import { createAiVisibilityTable } from './ai-visibility-create';
import {
  aiVisibilityFor, aiVisibilityRecord, aiVisibilityView, estimateAsk, startAsk, type AiVisibilityView,
} from './ai-visibility-run';
import { setAiVisibilityBrands } from './ai-visibility-brands';
import { estimateCheck, startCheck } from './ai-visibility-check';
import type { CheckView } from './ai-visibility-check-store';
import { spendCapRefusal } from './token-spend';
import { soonNote, timeZoneOf } from '../lib/ai-visibility/check';
import { startRefusalMessage, takeRunStart, type RunFail } from './run-shared';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const bad = (message: string): RunFail => ({ fail: 'bad_request', message });
const notFound: RunFail = { fail: 'not_found', message: 'AI visibility table not found' };

const checkJson = (c: CheckView) => ({
  id: c.id, answers_of: c.label, stage: c.stage, checked_at: c.checkedAt,
  questions_copy_sheet_id: c.questionsCopySheetId, sites_copy_sheet_id: c.sitesCopySheetId,
  named_by_column: c.namedByColumn, change_column: c.changeColumn,
  runs: c.runs.map(r => ({ column: r.column, run_id: r.runId, rows: r.rows })), problems: c.problems,
});

const viewJson = (v: AiVisibilityView) => ({
  id: v.id, table_id: v.tableId, questions_sheet_id: v.questionsSheetId, sites_sheet_id: v.sitesSheetId,
  brand: v.brand, other_brands: v.competitors, domain: v.domain, country: v.country, engines: v.engines,
  answers_at: v.answersAt, checks: v.checks.map(checkJson),
});

export async function agentCreateAiVisibility(userId: string, body: unknown): Promise<{ ok: Json } | RunFail> {
  const b = isObj(body) ? body : {};
  const input = parseAiVisibilityInput({ ...b, competitors: b.other_brands ?? b.competitors });
  if (typeof input === 'string') return bad(input);
  const made = await createAiVisibilityTable(userId, input);
  if ('fail' in made) return made;
  const rec = aiVisibilityRecord(userId, made.ok.id);
  if (!rec) return notFound;
  return {
    ok: {
      ...viewJson(aiVisibilityView(rec)), table_name: made.ok.tableName, questions: made.ok.questions,
      problems: made.ok.problems,
      next: 'Nothing was asked yet. ai_visibility action "ask" (estimate_only first) asks every engine each question.',
    },
  };
}

// id: the table's ai_visibility id, or its Questions sheet's id.
export async function agentAskAiVisibility(
  userId: string, tokenId: string, id: unknown, opts: { again?: boolean; estimateOnly: boolean },
): Promise<{ ok: Json } | RunFail> {
  const rec = aiVisibilityFor(userId, id);
  if (!rec) return notFound;
  const again = opts.again === true;
  if (opts.estimateOnly) {
    const e = await estimateAsk(userId, rec, again);
    return {
      ok: {
        estimate_only: true, questions: e.rows, low_usd: e.lowUsd, high_usd: e.highUsd, problems: e.problems,
        engines: e.engines.map(x => ({ column: x.column, rows: x.rows, low_usd: x.lowUsd, high_usd: x.highUsd })),
        ...(e.dailyLimit ? { daily_limit: e.dailyLimit } : {}),
      },
    };
  }
  const refuse = () => { const r = takeRunStart(userId, tokenId); return r ? startRefusalMessage(r) : null; };
  const started = await startAsk(userId, rec, again, refuse);
  if ('fail' in started) return started;
  return {
    ok: {
      runs: started.started.map(s => ({ column: s.column, run_id: s.runId, rows: s.rows })), problems: started.problems,
      next: 'Each run is an enrichment run: follow it with get_run_status (run type enrichment).',
    },
  };
}

// Check again: the plan and its cost (the default), or the check itself, which
// takes the token's run-start slot before each engine, like ask. A token at its
// spend cap is refused before anything is copied. time_zone: the day in the
// names is the asker's (UTC without it).
export async function agentCheckAiVisibility(
  userId: string, tokenId: string, id: unknown, opts: { estimateOnly: boolean; timeZone?: unknown; fresh?: boolean },
): Promise<{ ok: Json } | RunFail> {
  const rec = aiVisibilityFor(userId, id);
  if (!rec) return notFound;
  const timeZone = timeZoneOf(opts.timeZone);
  if (opts.timeZone !== undefined && opts.timeZone !== null && !timeZone) {
    return bad('time_zone must be an IANA time zone, such as Europe/Berlin or America/New_York.');
  }
  const checkOpts = { timeZone, fresh: opts.fresh === true };
  if (opts.estimateOnly) {
    const out = await estimateCheck(userId, rec, checkOpts);
    if ('fail' in out) return out;
    const { plan, estimate: e } = out;
    return {
      ok: {
        estimate_only: true, answers_of: plan.label, answers_days_old: plan.days, questions: plan.questions,
        low_usd: e.lowUsd, high_usd: e.highUsd, problems: e.problems,
        engines: plan.engines,
        will_make: { questions_copy: plan.names.questionsCopy, sites_copy: plan.names.sitesCopy,
          named_by_column: plan.names.namedBy, change_column: plan.names.change },
        ...(plan.picksUp ? { picks_up: { check_id: plan.picksUp, note: 'A check that stopped: its kept answers and '
          + 'columns stay, and only the engines it didn\'t start are asked. fresh: true starts a new check instead.' },
        } : {}),
        ...(plan.soon ? { note: soonNote(plan.days) } : {}),
        ...(e.dailyLimit ? { daily_limit: e.dailyLimit } : {}),
      },
    };
  }
  const capped = spendCapRefusal(userId, tokenId, null);
  if (capped) return { fail: 'forbidden', message: capped };
  const refuse = () => { const r = takeRunStart(userId, tokenId); return r ? startRefusalMessage(r) : null; };
  const out = await startCheck(userId, rec, { ...checkOpts, refuse });
  if ('fail' in out) return out;
  return {
    ok: {
      ...checkJson(out.ok),
      next: 'Each run is an enrichment run: follow it with get_run_status (run type enrichment). The change '
        + 'column fills as the answers come.',
    },
  };
}

// What's left out stays as it is: the brand, or the other brands (a list given replaces them).
export async function agentSetAiVisibilityBrands(
  userId: string, id: unknown, body: unknown,
): Promise<{ ok: Json } | RunFail> {
  const rec = aiVisibilityFor(userId, id);
  if (!rec) return notFound;
  const b = isObj(body) ? body : {};
  const others = b.other_brands ?? b.competitors ?? aiVisibilityView(rec).competitors;
  const brands = parseBrands({ brand: b.brand ?? rec.brand, competitors: others });
  if (typeof brands === 'string') return bad(brands);
  const saved = await setAiVisibilityBrands(userId, rec, brands);
  const now = aiVisibilityRecord(userId, rec.id) ?? rec;
  return { ok: { ...viewJson(aiVisibilityView(now)), formulas_rewritten: saved.columns, problems: saved.problems } };
}
