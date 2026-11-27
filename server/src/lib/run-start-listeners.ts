// What follows an enrichment run however it was started (the app, an agent, a column's menu, auto-run): each listener
// is told once the run has started (services/enrich-run-start.ts), with the run and its config, and only reads and
// schedules (services/open-roles-lookups.ts watches an Open roles run so). One that throws is logged; the start has
// answered already.
import type { EnrichRunConfig } from './enrich-run-config';

type Listener = (userId: string, sheetId: string, runId: string, config: EnrichRunConfig) => void;
const listeners: Listener[] = [];

export function onEnrichmentRunStarted(listener: Listener): void {
  listeners.push(listener);
}

export function enrichmentRunStarted(userId: string, sheetId: string, runId: string, config: EnrichRunConfig): void {
  for (const listener of listeners) {
    try {
      listener(userId, sheetId, runId, config);
    } catch (error) {
      console.error(`A listener on run ${runId}'s start failed:`, error);
    }
  }
}
