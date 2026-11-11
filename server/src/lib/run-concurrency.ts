// concurrency on a rerun or a resume (MCP control_run, POST /api/v1/{ai,http}-runs/:id/{rerun,resume}): how many
// rows a run keeps going at once. An AI run takes 1 to MAX_AI_CONCURRENCY; an HTTP API or enrichment run 1 to
// HTTP_MAX_CONCURRENCY (an HTTP API run's batch size), in the words an enrichment's start uses. Both surfaces
// refuse with these words.
import { HTTP_MAX_CONCURRENCY } from './constants';
import { MAX_AI_CONCURRENCY } from './constants-ai';
import { CONCURRENCY_ERROR } from './enrich-run-input';

export const AI_CONCURRENCY_ERROR = `concurrency must be a whole number from 1 to ${MAX_AI_CONCURRENCY}.`;

const wholeIn = (v: unknown, max: number): boolean =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max;

// An HTTP API run's (left out: the run's own batch size), or the refusal. null counts as sent, as over MCP.
export const httpConcurrencyProblem = (v: unknown): string | null =>
  v === undefined || wholeIn(v, HTTP_MAX_CONCURRENCY) ? null : CONCURRENCY_ERROR;

// An AI run's, or the refusal.
export const aiConcurrencyProblem = (v: unknown): string | null =>
  v === undefined || wholeIn(v, MAX_AI_CONCURRENCY) ? null : AI_CONCURRENCY_ERROR;

// control_run's schema checks concurrency before it knows the run's kind: up to the larger bound, and in the
// words both kinds share when their bounds are the same (the default). Each kind's own bound is checked after.
export const CONTROL_CONCURRENCY_MAX = Math.max(MAX_AI_CONCURRENCY, HTTP_MAX_CONCURRENCY);
export const CONTROL_CONCURRENCY_ERROR = MAX_AI_CONCURRENCY === HTTP_MAX_CONCURRENCY ? CONCURRENCY_ERROR
  : `concurrency must be a whole number from 1 to ${MAX_AI_CONCURRENCY} for an AI run, or from 1 to `
    + `${HTTP_MAX_CONCURRENCY} for an HTTP API or enrichment run.`;
