// AI visibility tables for agents: the answers /api/v1 and the MCP tool give
// (snake_case), over the same services as the app. Asking the engines is paid:
// each start takes the token's run-start slot and stops at its spend cap.
import { parseAiVisibilityInput, parseBrands } from '../lib/ai-visibility/input';
import { createAiVisibilityTable } from './ai-visibility-create';
import {
  aiVisibilityFor, aiVisibilityRecord, aiVisibilityView, estimateAsk, startAsk, type AiVisibilityView,
} from './ai-visibility-run';
import { setAiVisibilityBrands } from './ai-visibility-brands';
import { startRefusalMessage, takeRunStart, type RunFail } from './run-shared';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const bad = (message: string): RunFail => ({ fail: 'bad_request', message });
const notFound: RunFail = { fail: 'not_found', message: 'AI visibility table not found' };

const viewJson = (v: AiVisibilityView) => ({
  id: v.id, table_id: v.tableId, questions_sheet_id: v.questionsSheetId, sites_sheet_id: v.sitesSheetId,
  brand: v.brand, other_brands: v.competitors, domain: v.domain, country: v.country, engines: v.engines,
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
