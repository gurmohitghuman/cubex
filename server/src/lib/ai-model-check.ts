// Is a model one OpenRouter offers? Checked when a run starts, is resumed,
// estimated or previewed, when a waterfall's AI step is built and when a
// default model is saved, so a retired, renamed or mistyped model is refused
// at once instead of failing every row until the run pauses itself.
//
// OpenRouter's model list (GET /models) holds catalog ids, its ":free" and
// ":batch" variants included. Routing variants (":nitro", ":floor", ":exacto",
// ":online") can follow any id, any number of them, and aren't listed. A
// ":batch" variant runs only through OpenRouter's batch API, which Cubex
// doesn't use: it is refused wherever a model is checked, list or no list, and
// left out of the lists Cubex shows (runnableModels).
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

// The id as the list names it (no preset, no routing variants) and what was
// taken off its end, or null for a preset ("@preset/<slug>" picks its own model).
function catalogPart(model: string): { id: string; tail: string } | null {
  let id = model.trim();
  if (id.startsWith('@preset/')) return null;
  const preset = id.indexOf('@preset/');
  let tail = preset > 0 ? id.slice(preset) : '';
  if (preset > 0) id = id.slice(0, preset);
  for (let v = lastVariant(id); v && ROUTING_VARIANTS.has(v.variant); v = lastVariant(id)) {
    tail = `:${v.variant}${tail}`;
    id = v.base;
  }
  return { id, tail };
}

// Pure: the refusal for a ":batch" variant (a deprecated catalog variant after it too), or null.
export function batchOnlyRefusal(model: string): string | null {
  const part = catalogPart(model);
  let v = part ? lastVariant(part.id) : null;
  const deprecated = v && DEPRECATED_CATALOG_VARIANTS.has(v.variant) ? `:${v.variant}` : '';
  if (v && deprecated) v = lastVariant(v.base);
  if (!part || !v || v.variant !== 'batch') return null;
  return `The model "${model.trim()}" is a batch-only variant: it runs only through OpenRouter's batch API, `
    + `which Cubex doesn't use. Use "${v.base}${deprecated}${part.tail}" instead.`;
}

// The models a list Cubex shows may hold: no ":batch" variant.
export const runnableModels = <T extends { id: string }>(models: T[]): T[] =>
  models.filter(m => batchOnlyRefusal(m.id) === null);

// Pure: `ids` is the list's model ids. A ":batch" variant is never listed.
export function modelListed(model: string, ids: ReadonlySet<string>): boolean {
  const part = catalogPart(model);
  if (!part) return true;
  if (batchOnlyRefusal(model)) return false;
  if (ids.has(part.id)) return true;
  const v = lastVariant(part.id);
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

// The refusal for a model that can't run, or null (listed, or no list): a
// ":batch" variant (with or without the list), or one the list doesn't have,
// with `fix` (what to do) after it.
export function modelGone(list: ModelList, model: string, fix?: string): string | null {
  const batch = batchOnlyRefusal(model);
  if (batch) return batch;
  if (!list || modelListed(model, list)) return null;
  return fix ? `${modelGoneMessage(model)} ${fix}` : modelGoneMessage(model);
}

export type ModelCheck = 'listed' | 'gone' | 'unchecked';

export async function checkModel(model: string): Promise<ModelCheck> {
  const list = await modelList();
  if (!list) return 'unchecked';
  return modelListed(model, list) ? 'listed' : 'gone';
}

// For a check with nothing between it and a write (a default model, a token's
// pre-check): read the list and look the model up. A ":batch" variant needs no list.
export async function modelProblem(model: string, fix?: string): Promise<string | null> {
  return batchOnlyRefusal(model) ?? modelGone(await modelList(), model, fix);
}
