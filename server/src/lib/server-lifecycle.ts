import type { Server } from 'http';
import { db } from './db';
import { redactSecrets } from './http-request';
import { startQueue, stopQueue, resumeRecoveredRuns } from '../queue';
import type { RecoveredRuns } from './orphan-runs';
import { evictIdleWebhookBuckets } from './webhook-bucket';
import { pruneWebhookKeys } from './webhook-idempotency';
import { pruneWriteKeys } from './write-idempotency';
import { writeTokenUsesNow } from './token-last-used';
import { writeRowCountsNow } from './row-counts';
import { WEBHOOK_BUCKET_IDLE_EVICT_MS } from './constants';
import { startAutorunLoop } from '../services/autorun-loop';
import { startSetupLoop } from '../services/setup-sweep';
import { startRunScheduleLoop } from '../services/run-schedule-fire';
import { startDerivedFollow } from '../services/derived-follow';
import { startListDrainLoop } from '../services/enrich-list-drain';
import { startAnswerPruneLoop } from '../services/answer-prune';
import { resumeAgePrunes } from '../services/answer-prune-age';
import { startLookupLoop } from '../services/lookup-host';
import { startAutoDedupeLoop } from '../services/auto-dedupe-checks';
import { startRunHookLoop } from '../services/run-hooks-dispatch';
import { startTrashLoop } from '../services/trash-purge';
import { startReleaseCheckLoop } from '../services/release-check';
import { resumeAiVisibilityChecks } from '../services/ai-visibility-check';
import { resumeHiringChecks } from '../services/hiring-check-watch';
import { closeWalCheckpointer } from './wal-checkpointer';
import { closeWalTurnReader } from './wal-turn';

// Run any value through redactSecrets before logging, so a stack trace or
// rejection reason that happens to embed a Bearer token / sk-... key /
// API URL with creds doesn't end up in centralized logs in plaintext.
// Errors get serialized via .stack first (preserves origin info), with a
// fallback to String() for non-Error rejections.
function redactForLog(value: unknown): string {
  try {
    if (value instanceof Error) return redactSecrets(value.stack || value.message);
    if (typeof value === 'string') return redactSecrets(value);
    return redactSecrets(JSON.stringify(value));
  } catch { return '[unloggable value]'; }
}

// Periodic idle-eviction of the in-memory per-token webhook rate-limit buckets
// (lib/webhook-bucket.ts). The Map is bounded by the number of ACTIVE webhooks
// (one per sheet), so this is cheap; the sweep just drops entries for webhooks
// that stopped receiving so a deleted/rotated token doesn't linger.
let webhookBucketSweep: ReturnType<typeof setInterval> | null = null;

// Set once a stop begins: what waits for the queue to start doesn't start then (startBackground).
let stopping = false;

// Start the HTTP server, then bring up the background-job queue.
// The queue runs Sidequest in-process (worker threads), so it shares the
// lifecycle of this Node process.
export const startBackground = (recovered?: RecoveredRuns) => {
  // List results journaled before a restart are added as rows (services/enrich-list-drain.ts).
  startListDrainLoop();
  // Stored answers: older answers of rows enriched again, and an unfinished
  // "Prune details older than 90 days" (services/answer-prune*.ts).
  startAnswerPruneLoop();
  resumeAgePrunes();
  // Lookups: dropped keys deleted, looked-up sheets kept current (services/lookup-purge.ts).
  startLookupLoop();
  // Auto-dedupe: builds a restart cut short go on, waiting checks are made (services/auto-dedupe-checks.ts).
  startAutoDedupeLoop();
  // "Run finished" webhooks: finished runs become signed notices (services/run-hooks-dispatch.ts).
  startRunHookLoop();
  // The trash: what was kept long enough goes for good, in slices; the change log is pruned (services/trash-purge.ts).
  startTrashLoop();
  // The release check: the latest release on GitHub, at most once a day (services/release-check.ts).
  startReleaseCheckLoop();
  startQueue()
    .then(() => {
      // A stop asked while the queue started: nothing more starts, the stop is closing the queue.
      if (stopping) return;
      // Auto-run starts runs, so it waits for the queue (services/autorun-loop.ts).
      startAutorunLoop();
      // Setups being used on sheets start their next steps (services/setup-runner.ts).
      startSetupLoop();
      // Scheduled reruns: what is due fires as a column run (services/run-schedule-fire.ts).
      startRunScheduleLoop();
      // A write to a clean, formula or lookup column's input works it out again at once (services/derived-follow.ts).
      startDerivedFollow();
      // An AI visibility check a restart cut short finishes its free part (services/ai-visibility-check.ts).
      resumeAiVisibilityChecks();
      // A hiring check a restart cut short waits for its search again, then sums up (services/hiring-check.ts).
      resumeHiringChecks();
      // Resume any runs reset on boot (resetOrphanedRuns flipped them to
      // 'pending') — only AFTER the queue is up to accept jobs. Best-effort:
      // a failure rolls the individual run to 'failed' inside resumeRecoveredRuns.
      if (recovered && (recovered.aiRunIds.length || recovered.httpRunIds.length)) {
        return resumeRecoveredRuns(recovered);
      }
    })
    .catch(err => {
      console.error('Failed to start Sidequest queue:', err);
      process.exit(1);
    });
  // Sweep idle webhook rate-limit buckets on the same cadence as the idle window,
  // and delete webhook Idempotency-Keys and row writes' idempotency keys over a day old.
  webhookBucketSweep = setInterval(() => {
    try { evictIdleWebhookBuckets(); } catch { /* best-effort */ }
    try { pruneWebhookKeys(); } catch (err) { console.error('Deleting expired webhook keys failed:', err); }
    // In slices that yield to requests (lib/write-idempotency.ts).
    pruneWriteKeys().catch(err => console.error('Deleting expired row write keys failed:', err));
  }, WEBHOOK_BUCKET_IDLE_EVICT_MS);
  webhookBucketSweep.unref();
};

// How long a stop lets requests still being answered finish (a live-update stream never does) before it closes
// their connections, and how long it waits for the process to end on its own before it ends it.
export const STOP_GRACE_MS = 2000;
export const STOP_BACKSTOP_MS = 5000;

// Graceful shutdown — important under tsx-watch, where the dev server
// restarts on file changes. Without stopQueue() we'd leak Sidequest worker
// threads across reloads and eventually exhaust the libuv thread pool.
// This is the only stop: the queue's own signal handlers are off (queue.ts).
export const installShutdownHandlers = (server: Server) => {
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopping = true;
    // After a crash, a failing exit, so the service manager starts Cubex again: systemd restarts it on failure
    // and launchd when it didn't exit cleanly (bin/cubex-service.sh). A requested stop is a clean exit.
    process.exitCode = signal === 'uncaughtException' ? 1 : 0;
    console.log(`Shutting down (${signal})...`);
    if (webhookBucketSweep) { clearInterval(webhookBucketSweep); webhookBucketSweep = null; }
    try { await stopQueue(); }
    catch (err) { console.error('Queue shutdown failed:', err); }
    // Access token uses not yet written (lib/token-last-used.ts), now that runs no longer write.
    writeTokenUsesNow();
    // Row counts made since their last write to sheets.counted_rows (lib/row-counts.ts), shown after the restart.
    writeRowCountsNow();
    // The checkpoint worker closes its connection (lib/wal-checkpointer.ts), and lib/wal-turn.ts its own.
    try { await closeWalCheckpointer(); closeWalTurnReader(); }
    catch (err) { console.error('Closing the WAL checkpoint worker failed:', err); }
    // Refresh planner stats so the next boot inherits up-to-date metadata.
    // Best effort — never block shutdown on it.
    try { db.pragma('optimize'); }
    catch (err) { console.error('PRAGMA optimize failed:', err); }
    // Then the process ends on its own: no new connections, idle ones closed now, and the rest once
    // STOP_GRACE_MS has let their requests finish. Ending so, not with process.exit, lets V8 finish compiling on
    // its threads first: an exit while it does can hang the process (nodejs/node#54918, the unit tests' kit too).
    server.close(() => console.log('Stopped.'));
    server.closeIdleConnections();
    setTimeout(() => server.closeAllConnections(), STOP_GRACE_MS).unref();
    // Backstop: something still keeping the process up after STOP_BACKSTOP_MS is named in the log, then the
    // process exits. V8 has long finished compiling by then.
    setTimeout(() => {
      console.error('Still running after the stop, ending it. Kept up by:',
        JSON.stringify(process.getActiveResourcesInfo()));
      process.exit();
    }, STOP_BACKSTOP_MS).unref();
  };

  // Last-resort safety nets.
  // unhandledRejection: log loudly but don't crash. A stray .then() without a
  // .catch() shouldn't take down the whole server. Node 18+ defaults to terminating,
  // which is too aggressive when one bad request would kill every running AI/HTTP run.
  process.on('unhandledRejection', (reason) => {
    // Redact tokens/keys before logging — a bubbled fetch failure could
    // include the Bearer header or sk-... key in its message verbatim.
    console.error('UNHANDLED REJECTION:', redactForLog(reason));
  });
  // uncaughtException: log, then exit cleanly. Node docs are clear: once a
  // synchronous exception escapes its handler, the process is in an undefined
  // state and continuing is unsafe.
  process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', redactForLog(err));
    shutdown('uncaughtException');
  });
  process.on('SIGTERM', () => { shutdown('SIGTERM'); });
  process.on('SIGINT', () => { shutdown('SIGINT'); });
};
