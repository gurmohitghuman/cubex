// How AI and HTTP API runs stay bounded: every call ends, a run stops when its
// provider keeps failing or its results can't be saved, and a run whose worker
// stopped is picked up again (lib/call-deadline.ts, lib/run-breaker.ts,
// lib/storage-failure.ts, services/stalled-runs.ts).
import { envInt } from './env-int';

// One AI call, body included. The SDK's own timeout (AI_REQUEST_TIMEOUT_MS)
// stops counting once the response headers arrive, so a body that stalls
// would hold its row, its run and a worker slot forever. Long enough for a
// slow reasoning model with web search; a call that reaches it may still be
// billed, so it is never sent again on its own.
export const AI_CALL_DEADLINE_MS = envInt('AI_CALL_DEADLINE_MS', 10 * 60_000);
// One HTTP API request: the column's own timeout bounds the wait for the
// headers and each gap in the body; this much on top of twice that bounds the
// whole request, so a server trickling bytes can't hold the row.
export const HTTP_TOTAL_SLACK_MS = 30_000;
// Resolving the host name before the address check (lib/outbound-guard.ts).
export const HTTP_DNS_TIMEOUT_MS = 10_000;

// This many rows failing in a row for a reason on the provider's or the
// account's side (no answer, 5xx, 429 after retries, a rejected key, no
// credits, a model that's gone) pause the run, with the last error, instead of
// writing ❌ into every row left. A row the provider answered resets the count.
export const RUN_BREAKER_FAILURES = envInt('RUN_BREAKER_FAILURES', 5);

// A run with every slot busy checks for a stop this often, so Pause and
// Cancel reach it while its rows are still out.
export const RUN_STOP_POLL_MS = 1_000;
// A running run beats updated_at this often while it waits on its rows.
export const RUN_HEARTBEAT_MS = 30_000;
// A running run whose beat is older than this has lost its worker: it is
// queued again (services/stalled-runs.ts), at most RUN_STALL_REQUEUE_MAX times
// in one process before it is paused for a person to look at.
export const RUN_STALL_MS = 5 * 60_000;
export const RUN_STALL_SWEEP_MS = 60_000;
export const RUN_STALL_REQUEUE_MAX = 3;

// Free space on the data folder below this is reported by /api/health, and a
// stalled run isn't queued again while it lasts (its results couldn't be saved).
export const DISK_LOW_BYTES = envInt('DISK_LOW_MB', 200) * 1024 * 1024;
