import type { TrimmedModel } from './openrouter';

// Model catalog search for the token surfaces (MCP list_models, GET /v1/models):
// case-insensitive substring on id or name, an exact id match first (searching
// "deepseek/deepseek-v4-flash" used to return a longer id ahead of it), and no
// descriptions: they run to paragraphs and made the full list ~170 KB.
export function searchModels(models: TrimmedModel[], search: string | undefined, limit: number) {
  const needle = search?.trim().toLowerCase();
  let matching = needle
    ? models.filter(m => m.id.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle))
    : models;
  if (needle) matching = [...matching.filter(m => m.id.toLowerCase() === needle), ...matching.filter(m => m.id.toLowerCase() !== needle)];
  return {
    models: matching.slice(0, limit).map(m => ({ id: m.id, name: m.name, context_length: m.context_length, pricing: m.pricing })),
    total_matching: matching.length,
  };
}
