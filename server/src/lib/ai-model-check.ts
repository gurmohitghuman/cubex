// Is a model one OpenRouter offers? Checked when a run starts, is resumed,
// estimated or previewed, when a waterfall's AI step is built and when a
// default model is saved, so a retired, renamed or mistyped model is refused
// at once instead of failing every row until the run pauses itself.
//
// OpenRouter's model list (GET /models) holds catalog ids, its ":free" and
// ":batch" variants included. Routing variants (":nitro", ":floor", ":exacto",
// ":online") can follow any id, any number of them, and aren't listed.
// ":thinking" and ":extended" are deprecated catalog variants: accepted when
// their model is listed, as they were before this check. A preset
// ("@preset/<slug>") picks its own model and passes; "<model>@preset/<slug>"
// is checked by its model.
// https://openrouter.ai/docs/guides/routing/model-variants
// https://openrouter.ai/docs/guides/features/presets
import { fetchModels, type ModelsResult } from './openrouter';
import { MODEL_CHECK_WAIT_MS } from './constants';

const ROUTING_VARIANTS = new Set(['nitro', 'floor', 'exacto', 'online']);
const DEPRECATED_CATALOG_VARIANTS = new Set(['thinking', 'extended']);

function lastVariant(id: string): { base: string; variant: string } | null {
  const at = id.lastIndexOf(':');
  return at > 0 ? { base: id.slice(0, at), variant: id.slice(at + 1) } : null;
}

// Pure: `ids` is the list's model ids.
export function modelListed(model: string, ids: ReadonlySet<string>): boolean {
  let id = model.trim();
  if (id.startsWith('@preset/')) return true;
  const preset = id.indexOf('@preset/');
  if (preset > 0) id = id.slice(0, preset);
  for (let v = lastVariant(id); v && ROUTING_VARIANTS.has(v.variant); v = lastVariant(id)) id = v.base;
  if (ids.has(id)) return true;
  const v = lastVariant(id);
  return !!v && DEPRECATED_CATALOG_VARIANTS.has(v.variant) && ids.has(v.base);
}

export const modelGoneMessage = (model: string) =>
  `OpenRouter doesn't offer the model "${model}": it was retired or renamed, or the name is mistyped.`;

// The ids to check against, or null for "can't check, let it start": no fresh
// list (OpenRouter down, or slower than MODEL_CHECK_WAIT_MS; a stale list would
// refuse a model added since), or an empty one (a proxy answering for it).
export type ModelList = ReadonlySet<string> | null;

// A read that already ran past the wait: the next check doesn't wait on it again.
let slowRead: Promise<ModelsResult> | null = null;

// Read before any of a start's own checks: from those checks to the run's
// insert nothing may wait (a second start, or the sheet going to the trash,
// could slip in), so the lookup there is modelGone(), which doesn't.
export async function modelList(): Promise<ModelList> {
  if (slowRead) return null;
  const read = fetchModels(Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>(resolve => { timer = setTimeout(() => resolve('late'), MODEL_CHECK_WAIT_MS); });
  const result = await Promise.race([read, late]).finally(() => clearTimeout(timer));
  if (result === 'late') {
    slowRead = read;
    void read.finally(() => { if (slowRead === read) slowRead = null; });
    return null;
  }
  if (!result.ok || result.models.length === 0) return null;
  return new Set(result.models.map(m => m.id));
}

// The refusal for a model the list doesn't have, or null (listed, or no list).
export function modelGone(list: ModelList, model: string): string | null {
  return list && !modelListed(model, list) ? modelGoneMessage(model) : null;
}

export type ModelCheck = 'listed' | 'gone' | 'unchecked';

export async function checkModel(model: string): Promise<ModelCheck> {
  const list = await modelList();
  if (!list) return 'unchecked';
  return modelListed(model, list) ? 'listed' : 'gone';
}

// For a check with nothing between it and a write (a default model, a token's
// pre-check): read the list and look the model up.
export async function modelProblem(model: string): Promise<string | null> {
  return modelGone(await modelList(), model);
}
