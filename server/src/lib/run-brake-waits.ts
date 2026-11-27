// The waits an AI or HTTP API run someone started sits out before its brake pauses it (lib/run-breaker.ts): when
// RUN_BREAKER_FAILURES rows in a row fail on the provider's side (no answer, 5xx, 429 after its retries), the run
// waits, beating, then goes on with the rows left, counting failures afresh; at most RUN_BREAKER_WAITS times, the
// nth wait RUN_BREAKER_WAIT_MS x n x n. A short outage overnight then costs a few ❌ rows, not a paused run. A stop
// (pause, cancel) ends a wait at once. Never for a failure on the account's side, or an auto-run batch.
import { RUN_BREAKER_WAIT_MS, RUN_BREAKER_WAITS, RUN_STOP_POLL_MS } from './constants';
import type { RunBreaker } from './run-breaker';

const words = (ms: number): string => (ms < 60_000 ? `${+(ms / 1000).toFixed(1)} s` : `${+(ms / 60_000).toFixed(1)} min`);

export class BrakeWaits {
  private used: number[] = [];
  private until = 0;
  constructor(private readonly most = RUN_BREAKER_WAITS, private readonly baseMs = RUN_BREAKER_WAIT_MS) {}

  // Starts the next wait and counts the run's failures afresh: false when none is left.
  begin(breaker: RunBreaker): boolean {
    if (this.used.length >= this.most) return false;
    const n = this.used.length + 1;
    const ms = this.baseMs * n * n;
    this.used.push(ms);
    this.until = Date.now() + ms;
    breaker.reset();
    return true;
  }

  get waiting(): boolean { return this.until > Date.now(); }

  // Sits out the wait begun, beating; stop() ends it early.
  async sit(beat: () => void, stop: () => boolean): Promise<void> {
    while (this.until > Date.now() && !stop()) {
      await new Promise(resolve => setTimeout(resolve, Math.min(RUN_STOP_POLL_MS, this.until - Date.now())));
      beat();
    }
    this.until = 0;
  }

  // The waits sat out, in words for the pause message: "30 s, 2 min and 4.5 min".
  get waited(): string {
    const w = this.used.map(words);
    return w.length < 2 ? w.join('') : `${w.slice(0, -1).join(', ')} and ${w[w.length - 1]}`;
  }
}
