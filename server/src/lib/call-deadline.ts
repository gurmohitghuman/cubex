// A hard end for one outbound call: a signal that aborts when the run stops
// (the parent signal) or when `ms` pass, whichever comes first, and says which.
// Built by hand rather than with AbortSignal.any so a long-lived run signal
// never collects a listener per row: done() removes it and the timer.
export interface CallDeadline {
  signal: AbortSignal;
  // The deadline fired (not the run's stop).
  timedOut(): boolean;
  // The call ended: drop the timer and the listener. Safe to call twice.
  done(): void;
}

export function callDeadline(ms: number, parent?: AbortSignal): CallDeadline {
  const controller = new AbortController();
  let expired = false;
  const onStop = () => controller.abort(parent?.reason);
  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener('abort', onStop, { once: true });
  const timer = setTimeout(() => {
    expired = true;
    controller.abort(new Error(`No answer within ${Math.round(ms / 1000)} seconds.`));
  }, ms);
  timer.unref?.();
  return {
    signal: controller.signal,
    timedOut: () => expired && !parent?.aborted,
    done: () => { clearTimeout(timer); parent?.removeEventListener('abort', onStop); },
  };
}

// "10 minutes", "90 seconds": a deadline in the words a cell shows.
export function deadlineWords(ms: number): string {
  if (ms >= 120_000 && ms % 60_000 === 0) return `${ms / 60_000} minutes`;
  return `${Math.round(ms / 1000)} seconds`;
}
