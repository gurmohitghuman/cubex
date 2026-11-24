// What the API thread (host.ts) and the formula worker (worker.ts) say to each
// other. A request goes over the port with its number; the worker answers on
// the port, then writes that number into READY in the shared flags and wakes
// the API thread, which waits (Atomics.wait) until READY holds its own
// request's number, with a wall-clock cap (host.ts says why).
import type { FormulaOutcome, FormulaRow } from './cells';

// Shared Int32 slots.
export const READY = 0;     // the number of the request answered last (its answer is on the port); 0: none yet
export const PROGRESS = 1;  // the row of the current request being worked out (-1: none yet)
export const CLOSING = 2;   // 1: the worker is going (its WASM instance broke); start a new one
export const SLOTS = 4;

// What the API thread asks (host.ts adds seq), and what needs no answer.
export type Ask =
  | { op: 'open'; sid: number; source: string; usesLodash: boolean }
  | { op: 'run'; sid: number; rows: FormulaRow[]; budgetMs: number };
export type Dispose = { op: 'dispose'; sid: number };
export type Request = (Ask & { seq: number }) | Dispose;

export type Reply =
  | { seq: number; ok: true }                      // open: compiled
  | { seq: number; error: string }                 // open: it doesn't compile (the person's message)
  | { seq: number; outcomes: FormulaOutcome[] }    // run: the first rows, as many as fit the budget
  | { seq: number; closed: true };                 // run: no such formula here (the worker started again)
