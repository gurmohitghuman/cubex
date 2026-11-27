// The id the model list prices a model under: routing variants that keep the
// model and its prices (":nitro", ":floor", ":exacto") and a preset after it
// are left out. ":online" adds web search fees, so it stays (and is unpriced).
// Its own module so lib/openrouter.ts can read the list by it without an import
// cycle (lib/ai-spend-limit.ts re-exports it, where its callers import it from).
const SAME_PRICE_VARIANTS = /:(nitro|floor|exacto)$/;
export function priceModelId(model: string): string {
  let id = model.trim();
  const preset = id.indexOf('@preset/');
  if (preset > 0) id = id.slice(0, preset);
  while (SAME_PRICE_VARIANTS.test(id)) id = id.replace(SAME_PRICE_VARIANTS, '');
  return id;
}
