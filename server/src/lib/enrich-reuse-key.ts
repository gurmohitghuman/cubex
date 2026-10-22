// Which earlier answer a row may reuse (pure). A key names one lookup: the
// tool and what decides treg's answer, the request the row sends
// (requestFingerprint: method, path, query, body, a waterfall's provider order
// and skips) and whether a waterfall stops at the first find. A Verified work
// email row is one answer for its whole loop (finds and checks), so its key
// adds the loop's settings. services/enrich-reuse.ts finds and writes them.
import { createHash } from 'node:crypto';
import { requestFingerprint, type BuiltRequest, type KeyParts } from './enrich-request';
import { acceptedCell } from './enrich-email-guess';
import type { EmailVerdict } from './enrich-email-status';
import type { RowCells } from './enrich-cells';
import type { EnrichRunConfig } from './enrich-run-config';
import { droppedPartFor } from './answer-paths';

type Built = Extract<BuiltRequest, { ok: true }>;
type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const VERDICTS = new Set<EmailVerdict>(['valid', 'catch_all', 'risky', 'invalid', 'no_verdict']);

// The request parts of a row's one call (a waterfall sends its route).
export function rowParts(config: EnrichRunConfig, built: Built): KeyParts {
  const e = config.enrichment;
  const route = e.kind === 'waterfall' ? e.route : { prefer: [], exclude: [] };
  return {
    method: built.method, path: built.path, query: built.query, body: built.body,
    prefer: route.prefer, exclude: route.exclude,
  };
}

export function reuseKeyOf(config: EnrichRunConfig, built: Built): string {
  const e = config.enrichment;
  const l = e.email;
  const loop = l
    ? [l.strategy, l.guess, l.pattern, l.verifyTool.id, l.verifyKind, [...l.verifyExclude].sort()]
    : null;
  return createHash('sha256')
    .update(JSON.stringify(['r1', e.toolId, requestFingerprint(rowParts(config, built)),
      e.kind === 'waterfall' && e.route.stopAtFirst, loop]))
    .digest('hex').slice(0, 32);
}

// Whether a row's answer may be reused later: found something (outputs filled,
// a list's results, an address that passed), and kept whole enough to read
// again. A single tool's answer is kept whole up to a size; one cut down to
// fit isn't reused, since a later run's outputs may read the part that went.
// A single tool run with no outputs counts every answer as found: not a find.
export function reusableAnswer(
  r: { cells: RowCells; stored: unknown; items?: unknown[] }, how: { list: boolean; routed: boolean; mapped: boolean },
): boolean {
  if (r.cells.status !== 'completed' || r.stored === undefined || r.stored === null) return false;
  if (!how.routed && isObj(r.stored) && Array.isArray(r.stored.$trimmedPaths)) return false;
  // A list job found something with results, or with its own outputs filled.
  if (how.list) return (r.items?.length ?? 0) > 0 || (how.mapped && r.cells.fill === 'all');
  return r.cells.fill === 'all' && (how.routed || how.mapped);
}

// The answer paths a run reads: its outputs and a list job's results.
export function answerPathsOf(config: EnrichRunConfig): string[] {
  const list = config.enrichment.list;
  return [...config.responseMapping.map(m => m.jsonPath), ...(list ? [list.itemsPath] : [])];
}

// What a stored answer lost: parts cut to fit, and the raw part a prune dropped.
export interface AnswerNotes { trimmedPaths: string[]; prunedAt: string | null }

// Whether the answer still holds every part these paths read (a waterfall's
// raw part can be cut or pruned while its output stays whole).
export const wholeFor = (paths: string[], n: AnswerNotes): boolean =>
  paths.every(p => droppedPartFor(p, n.trimmedPaths, n.prunedAt !== null) === null);

// Whether any of them reads the raw part (the only part a waterfall's answer loses).
export const readsRaw = (paths: string[]): boolean =>
  paths.some(p => /^\$(\.raw\b|\[['"]raw['"]\]|\.\.|\.\*|\[\*\])/.test(p));

// The reused copy keeps the notes, so the answer panel and "Add as column" know
// what it lacks.
export function withNotes(stored: unknown, n: AnswerNotes): unknown {
  if (!isObj(stored) || (!n.prunedAt && n.trimmedPaths.length === 0)) return stored;
  const had = Array.isArray(stored.$trimmedPaths) ? stored.$trimmedPaths as string[] : [];
  return {
    ...stored, ...(n.prunedAt ? { $prunedAt: n.prunedAt } : {}),
    ...(n.trimmedPaths.length ? { $trimmedPaths: [...new Set([...had, ...n.trimmedPaths])] } : {}),
  };
}

// Where a reused answer came from, under _cubex.reused_from.
export interface ReusedFrom { run_id: string; sheet_id: string; answered_at: string }

// An answer as read back for reuse: the provider's answer without the notes
// the earlier row added (Cubex adds this row's own).
export function freshBody(body: unknown): unknown {
  if (!isObj(body) || !('_cubex' in body)) return body;
  const { _cubex: _drop, ...rest } = body;
  return rest;
}

// A Verified work email row reused whole: the address that passed, its
// verdict and steps, as the earlier row wrote them (null: not an answer
// the loop accepted).
export function reusedEmailCells(body: unknown, from: ReusedFrom): RowCells | null {
  const c = isObj(body) && isObj(body._cubex) ? body._cubex : null;
  const verdict = c?.verdict as EmailVerdict | undefined;
  if (!c || typeof c.email !== 'string' || !verdict || !VERDICTS.has(verdict)) return null;
  const answer = { ...(body as Json), _cubex: { ...c, reused_from: from } };
  return { status: 'completed', statusCell: acceptedCell(verdict), answer, fill: 'all', reason: null };
}
