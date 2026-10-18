import { envInt } from './env-int';

// "Run finished" webhooks (services/run-hooks-*.ts, docs/run-webhooks.md).
// Guards, not quotas.
export const RUN_HOOK_MAX_ENDPOINTS = 10;
export const RUN_HOOK_URL_MAX_CHARS = 2000;
// Tries per notice: the first at once, then after RUN_HOOK_RETRY_BASE_MS, then
// six times that (each with some jitter), unless the receiver's Retry-After asks
// for longer (up to a minute).
export const RUN_HOOK_TRIES = 3;
export const RUN_HOOK_RETRY_BASE_MS = envInt('RUN_HOOK_RETRY_BASE_MS', 10_000);
// One try's whole deadline: connect, send, answer.
export const RUN_HOOK_TIMEOUT_MS = envInt('RUN_HOOK_TIMEOUT_MS', 10_000);
// How often the API process turns finished runs into notices and sends them.
export const RUN_HOOK_SWEEP_MS = envInt('RUN_HOOK_SWEEP_MS', 1000);
// Notices out at once, across every webhook.
export const RUN_HOOK_CONCURRENCY = 4;
// Finished notices kept per webhook: its delivery log.
export const RUN_HOOK_LOG_KEEP = 50;
// A webhook that can't keep up stops queueing more than this many waiting
// notices; later ones are logged as not sent.
export const RUN_HOOK_MAX_WAITING = 200;
export const RUN_HOOK_EVENTS_PER_SWEEP = 500;
// What a receiver gets back on a failure in the log, at most.
export const RUN_HOOK_ERROR_MAX_CHARS = 300;
// Signing secrets look like this (lib/redact.ts strips them from logs).
export const RUN_HOOK_SECRET_PREFIX = 'cubex_whsig_';
