import { AIRun } from '@/utils/api'

// Map a prior AI run row into the config shape shared by "Run All Rows"
// (aiAPI.startRun) and the edit-column modal prefill. Extracted so the two
// call sites can't drift — if a run column isn't forwarded here, a re-run or
// edit silently loses it (web-search flags → missing (Data) column, etc.).
export function aiRunConfigFromLatest(latest: AIRun, columnName: string) {
  const r = latest as any
  return {
    columnName,
    prompt: r.prompt,
    systemPrompt: r.system_prompt,
    model: r.model,
    temperature: r.temperature,
    useOpenRouterWebSearch: !!r.use_openrouter_web_search,
    useWebFetch: !!r.use_web_fetch,
    maxChars: r.max_chars,
    concurrency: r.concurrency,
  }
}
