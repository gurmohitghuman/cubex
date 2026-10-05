import type { Server } from 'http';
import { db } from './db';
import { redactSecrets } from './http-request';
import { startQueue, stopQueue, resumeRecoveredRuns } from '../queue';
import type { RecoveredRuns } from './orphan-runs';
import { evictIdleWebhookBuckets } from './webhook-bucket';
import { WEBHOOK_BUCKET_IDLE_EVICT_MS } from './constants';

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

// Start the HTTP server, then bring up the background-job queue.
// The queue runs Sidequest in-process (worker threads), so it shares the
// lifecycle of this Node process.
export const startBackground = (recovered?: RecoveredRuns) => {
  startQueue()
    .then(() => {
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
  // Sweep idle webhook rate-limit buckets on the same cadence as the idle window.
  webhookBucketSweep = setInterval(() => {
    try { evictIdleWebhookBuckets(); } catch { /* best-effort */ }
  }, WEBHOOK_BUCKET_IDLE_EVICT_MS);
  webhookBucketSweep.unref();
};

// Graceful shutdown — important under tsx-watch, where the dev server
// restarts on file changes. Without stopQueue() we'd leak Sidequest worker
// threads across reloads and eventually exhaust the libuv thread pool.
export const installShutdownHandlers = (server: Server) => {
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Shutting down (${signal})...`);
    if (webhookBucketSweep) { clearInterval(webhookBucketSweep); webhookBucketSweep = null; }
    try { await stopQueue(); }
    catch (err) { console.error('Queue shutdown failed:', err); }
    // Refresh planner stats so the next boot inherits up-to-date metadata.
    // Best effort — never block shutdown on it.
    try { db.pragma('optimize'); }
    catch (err) { console.error('PRAGMA optimize failed:', err); }
    server.close(() => process.exit(0));
    // Hard timeout: if the HTTP server doesn't drain in 5s, exit anyway.
    setTimeout(() => process.exit(0), 5000).unref();
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
