// An AI run's row, sent once the columns its prompt reads are free (services/run-input-gate.ts): it waits while
// another run holds one, keeping its slot and its spend hold, then reads the row again. A stop during the wait
// leaves the row ⏳ for its run. A row whose wait would close a ring of runs fails with the ring's words through
// the row's own failure writer; that failure isn't the provider's, so the brake (lib/run-breaker.ts) skips it.
import type OpenAI from 'openai';
import { DROPPED, type RowOutcome } from '../lib/run-breaker';
import { processRow } from './ai-row';
import type { InputGate } from './run-input-gate';
import type { AIRunRow, SheetRow } from './ai-runner-status';

export async function processRowWhenFree(
  gate: InputGate, runId: string, row: SheetRow, run: AIRunRow, openai: OpenAI, signal: AbortSignal | undefined,
  myGeneration: number, columns: readonly string[],
): Promise<RowOutcome> {
  const ready = await gate.ready(row, signal);
  if ('stopped' in ready) return DROPPED;
  if ('go' in ready) return processRow(runId, ready.go, run, openai, signal, myGeneration, columns);
  const out = await processRow(runId, { ...row, refused: ready.ring }, run, openai, signal, myGeneration, columns);
  return out.kind === 'failed' ? { ...out, provider: false } : out;
}
