// Which kind of run an HTTP run's config is (pure): a plain HTTP API column,
// an enrichment (config.enrichment, treg) or a waterfall (config.waterfall,
// ordered steps). The run tables, placeholders and controls are the same for
// all three; what a run's cells hold and how it starts again differ.
import { isEnrichmentConfig } from './enrich-run-config';
import { isWaterfallConfig } from './waterfall/config';

export type HttpRunMode = 'http' | 'enrichment' | 'waterfall';

export function httpRunMode(config: unknown): HttpRunMode {
  if (isWaterfallConfig(config)) return 'waterfall';
  return isEnrichmentConfig(config) ? 'enrichment' : 'http';
}

// A stored config string's mode ('http' when it isn't JSON).
export function httpRunModeOf(raw: string | null | undefined): HttpRunMode {
  try { return httpRunMode(JSON.parse(raw ?? 'null')); } catch { return 'http'; }
}

// Its stored cells are written whole by its own writer, so a live stream replays them exactly.
export const writesWholeCells = (mode: HttpRunMode): boolean => mode !== 'http';
