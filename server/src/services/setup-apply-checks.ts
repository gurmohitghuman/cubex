// What using a setup on a sheet checks against the account, after it's fitted
// to the sheet (setup-apply.ts): the AI models, the saved keys its requests
// read, and other setups still working on the sheet.
import { db } from '../lib/db';
import { resolveAiModel } from '../lib/ai-model-resolve';
import { fetchModels } from '../lib/openrouter';
import { savedKeyRefsInConfig } from '../lib/http-secrets-scan';
import { templateTokenIs } from '../lib/template-token-match';
import type { SheetColumnStep, StepMode } from '../lib/setups/again';
import { mainColumn, stepColumns, type SetupSpec } from '../lib/setups/spec';
import { savedKeyNames } from './saved-keys';
import { planOf, type SetupRunRow } from './setup-run-store';
import type { RunFail } from './run-shared';

export type ApplyFail = RunFail & { missing?: string[]; taken?: string[] };

const bad = (message: string): ApplyFail => ({ fail: 'bad_request', message });
const list = (names: string[]) => names.map(n => `"${n}"`).join(', ');

// The model each AI step runs on: a new step the one picked for it (by the
// setup's own name for it, `saved`), else its saved one, else the defaults;
// a step carrying a column on runs on the column's own model, so another one
// picked for it is refused. Each must still be on OpenRouter.
export async function withModels(
  fitted: SetupSpec, saved: SetupSpec, models: Record<string, string>, modes: StepMode[],
  existing: SheetColumnStep[], sheetId: string, userId: string,
): Promise<SetupSpec | ApplyFail> {
  const catalog = await fetchModels(Date.now());
  const steps = [];
  for (const [i, s] of fitted.steps.entries()) {
    if (s.kind !== 'ai') { steps.push(s); continue; }
    const asked = models[mainColumn(saved.steps[i])]?.trim() || undefined;
    let step = asked ? { ...s, model: asked } : s;
    if (modes[i] === 'again') {
      const own = existing.find(c => c.columns[0] === mainColumn(s))?.step;
      const ownModel = resolveAiModel((own?.kind === 'ai' ? own.model : null) ?? undefined, sheetId, userId);
      if (asked && asked !== ownModel) {
        return bad(`"${mainColumn(s)}" is in this sheet already and carries on with its own model `
          + `(${ownModel ?? 'none'}). Give the step another name to run it on "${asked}".`);
      }
      step = { ...s, model: ownModel };
    }
    const model = resolveAiModel(step.model ?? undefined, sheetId, userId);
    if (!model) {
      return bad(modes[i] === 'again'
        ? `"${mainColumn(s)}" has no model of its own and there's no default model. Set one in Settings.`
        : `Pick a model for "${mainColumn(s)}": there's no default model to use.`);
    }
    if (catalog.ok && !catalog.models.some(m => m.id === model)) {
      const fix = modes[i] === 'again' ? 'Pick another in the column\'s Edit, or give the step another name.'
        : 'Pick another.';
      return bad(`The model "${model}" of "${mainColumn(s)}" isn't on OpenRouter anymore. ${fix}`);
    }
    steps.push(step);
  }
  return { ...fitted, steps };
}

// Saved keys the setup's requests read: they must exist, no column may stand
// in their place, and a token needs 'secrets' to use them.
export function keyProblem(
  userId: string, spec: SetupSpec, columns: string[], hasSecretsScope: boolean,
): ApplyFail | null {
  const saved = new Set(savedKeyNames(userId));
  const missing = spec.keys.filter(k => !saved.has(k));
  if (missing.length) {
    return bad(`Add the saved key${missing.length > 1 ? 's' : ''} ${list(missing)} in Settings first.`);
  }
  const all = [...columns, ...spec.steps.flatMap(stepColumns)];
  const shadowed = spec.keys.find(k => all.some(c => templateTokenIs(k, c)));
  if (shadowed) return bad(`A column named like the saved key "${shadowed}" would be read in its place. Rename it.`);
  const reads = spec.steps.flatMap(s => (s.kind === 'http' ? savedKeyRefsInConfig(userId, {
    method: s.request.method, url: s.request.url, headers: s.request.headers, body: s.request.body ?? undefined,
  }) : []));
  if (reads.length && !hasSecretsScope) {
    return { fail: 'forbidden', message: `This setup's requests read saved keys (${list([...new Set(reads)])}). `
      + 'The access token needs the \'secrets\' scope.' };
  }
  return null;
}

// Another setup still working on this sheet makes (or carries on) columns of
// its own: none may be one of these.
export function liveSetupClash(userId: string, sheetId: string, makes: string[]): ApplyFail | null {
  const live = db.prepare(`SELECT * FROM setup_runs WHERE sheet_id = ? AND user_id = ?
    AND status IN ('running', 'paused')`).all(sheetId, userId) as SetupRunRow[];
  const coming = new Set(live.flatMap(r => planOf(r).spec.steps.flatMap(stepColumns)).map(c => c.toLowerCase()));
  const clash = makes.filter(c => coming.has(c.toLowerCase()));
  if (!clash.length) return null;
  return { fail: 'conflict', taken: clash, message: `Another setup working on this sheet makes ${list(clash)}. `
    + 'Wait for it to end, or give those steps other names.' };
}
