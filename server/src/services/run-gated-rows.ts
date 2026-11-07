// The rows a run's loop starts (HTTP API, enrichment, waterfall and AI runs), each let through the input gate
// first (services/run-input-gate.ts): the loop waits there, before the row takes a slot of the run's own or any
// spend is sized or held for it, so a waiting row holds nothing. next() gives the next row once it can go, a
// row to fail in a ring, or why there is none; now() fills a batch whose spend is already sized with rows that
// can go at once, never waiting (one that can't is kept for next()). A row deleted meanwhile is passed over.
import type { GateRow, InputGate } from './run-input-gate';

export type Pulled<R> = { row: R; ring?: string } | { done: true } | { stopped: true } | { park: true };

export class GatedRows<R extends GateRow> {
  private carry: R | null = null;
  constructor(private readonly source: AsyncIterator<R>, private readonly gate: InputGate) {}

  private async pull(): Promise<R | null> {
    const kept = this.carry;
    this.carry = null;
    if (kept) return kept;
    const n = await this.source.next();
    return n.done ? null : n.value;
  }

  // Whether a row is left (kept for next()).
  async left(): Promise<boolean> {
    this.carry = await this.pull();
    return this.carry !== null;
  }

  async next(opts?: { signal?: AbortSignal; tick?: () => void }): Promise<Pulled<R>> {
    for (;;) {
      const row = await this.pull();
      if (!row) return { done: true };
      const r = await this.gate.ready(row, opts);
      if ('go' in r) return { row: r.go };
      if ('ring' in r) return { row, ring: r.ring };
      if ('gone' in r) continue;
      return 'park' in r ? { park: true } : { stopped: true };
    }
  }

  async now(): Promise<R | null> {
    for (;;) {
      const row = await this.pull();
      if (!row) return null;
      const c = this.gate.check(row);
      if ('go' in c) return c.go;
      if ('gone' in c) continue;
      this.carry = row;
      return null;
    }
  }
}
