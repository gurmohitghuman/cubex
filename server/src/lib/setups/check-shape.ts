// One imported step, field by field (pure, check.ts): the step rebuilt from
// the fields its kind has, each of the right type, or what's wrong. Nothing
// else in the file is kept. Text is bounded by the whole setup's size
// (MAX_SETUP_SPEC_BYTES), never tighter than a column's own setup allows, so
// everything saving writes reads back. Values are checked again by the start
// service when the setup is used (a model that exists, a cleaner's options, a
// JSONPath). Objects keyed by name (headers, inputs) are built with
// Object.fromEntries, so a key named "__proto__" stays a plain key.
import { CLEANERS } from '../clean/cleaners';
import { MAX_SETUP_SPEC_BYTES } from '../constants-setups';
import type { AutoRunSpec, SetupStep } from './spec';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

class Bad extends Error {}
const need = (ok: boolean, what: string) => { if (!ok) throw new Bad(what); };
const str = (v: unknown, what: string, max = MAX_SETUP_SPEC_BYTES): string => {
  need(typeof v === 'string' && v.length <= max, `${what} must be text.`);
  return v as string;
};
const name = (v: unknown, what: string): string => {
  need(typeof v === 'string' && v.trim() !== '' && v.length <= 200, `${what} must be a column name.`);
  return v as string;
};
const strOrNull = (v: unknown, what: string) => (v === null || v === undefined ? null : str(v, what));
const bool = (v: unknown, what: string): boolean => {
  need(typeof v === 'boolean', `${what} must be true or false.`);
  return v as boolean;
};
const num = (v: unknown, what: string): number | null => {
  if (v === null || v === undefined) return null;
  need(typeof v === 'number' && Number.isFinite(v), `${what} must be a number.`);
  return v as number;
};
const int = (v: unknown, what: string): number | null => {
  const n = num(v, what);
  need(n === null || Number.isSafeInteger(n), `${what} must be a whole number.`);
  return n;
};
const list = <T>(v: unknown, what: string, item: (x: unknown) => T): T[] => {
  need(Array.isArray(v) && v.length <= 500, `${what} must be a list.`);
  return (v as unknown[]).map(item);
};
const obj = (v: unknown, what: string): Obj => { need(isObj(v), `${what} must be an object.`); return v as Obj; };

function autoRun(v: unknown): AutoRunSpec | null {
  if (v === null || v === undefined) return null;
  const a = obj(v, 'autoRun');
  return { runIf: strOrNull(a.runIf, 'autoRun.runIf'), dailyCapUsd: num(a.dailyCapUsd, 'autoRun.dailyCapUsd'),
    dailyRowCap: int(a.dailyRowCap, 'autoRun.dailyRowCap') };
}

// A cleaner's options are a few words or numbers, never anything nested.
function cleanOptions(v: unknown): Record<string, unknown> {
  const o = obj(v ?? {}, 'options');
  const entries = Object.entries(o);
  const plain = (x: unknown) => x === null || ['string', 'number', 'boolean'].includes(typeof x);
  need(entries.length <= 20 && entries.every(([, x]) => plain(x)), 'A cleaner\'s options must be a few plain values.');
  return Object.fromEntries(entries);
}

function build(s: Obj): SetupStep {
  const base = { name: name(s.name, 'name') };
  switch (s.kind) {
    case 'ai': {
      const search = s.search === null || s.search === undefined ? null : obj(s.search, 'search');
      return {
        kind: 'ai', ...base, prompt: str(s.prompt, 'prompt'), systemPrompt: strOrNull(s.systemPrompt, 'systemPrompt'),
        model: strOrNull(s.model, 'model'), temperature: num(s.temperature, 'temperature') ?? 0.7,
        maxChars: int(s.maxChars, 'maxChars'), concurrency: int(s.concurrency, 'concurrency'),
        webSearch: bool(s.webSearch, 'webSearch'), webFetch: bool(s.webFetch, 'webFetch'),
        search: search && {
          engine: str(search.engine, 'search.engine', 50), mode: strOrNull(search.mode, 'search.mode'),
          maxPerRow: int(search.maxPerRow, 'search.maxPerRow'),
        },
        outputColumns: s.outputColumns === null || s.outputColumns === undefined ? null
          : list(s.outputColumns, 'outputColumns', o => {
            const x = obj(o, 'An output column');
            need(['string', 'number', 'boolean'].includes(x.type as string), 'An output column\'s type is unknown.');
            return { columnName: name(x.columnName, 'columnName'), type: x.type as 'string' | 'number' | 'boolean',
              description: str(x.description, 'description') };
          }),
        runIf: strOrNull(s.runIf, 'runIf'),
      };
    }
    case 'http': {
      const r = obj(s.request, 'request');
      need(['GET', 'POST', 'PUT', 'DELETE'].includes(r.method as string),
        'request.method must be GET, POST, PUT or DELETE.');
      const headers: Record<string, string> = Object.fromEntries(
        Object.entries(obj(r.headers ?? {}, 'request.headers')).map(([k, v]) => [k, str(v, 'A header')]));
      return {
        kind: 'http', ...base,
        request: {
          method: r.method as 'GET', url: str(r.url, 'request.url'), headers,
          body: strOrNull(r.body, 'request.body'), timeout: int(r.timeout, 'request.timeout'),
        },
        mappings: list(s.mappings, 'mappings', m => {
          const x = obj(m, 'A mapping');
          return { jsonPath: str(x.jsonPath, 'jsonPath'), columnName: name(x.columnName, 'columnName') };
        }),
        batchSize: int(s.batchSize, 'batchSize'), runIf: strOrNull(s.runIf, 'runIf'), autoRun: autoRun(s.autoRun),
      };
    }
    case 'enrichment': {
      const inputs: Record<string, { column: string } | { value: string }> = Object.fromEntries(
        Object.entries(obj(s.inputs, 'inputs')).map(([k, v]) => {
          const b = obj(v, 'An input');
          return [k, 'column' in b
            ? { column: name(b.column, 'An input column') } : { value: str(b.value, 'An input') }];
        }));
      const email = s.email === null || s.email === undefined ? null : obj(s.email, 'email');
      return {
        kind: 'enrichment', ...base, toolId: str(s.toolId, 'toolId', 200), toolName: str(s.toolName, 'toolName'),
        preset: s.preset === 'verified_email' ? 'verified_email' : null, inputs,
        cleanDomains: bool(s.cleanDomains, 'cleanDomains'),
        providerOrder: list(s.providerOrder, 'providerOrder', p => str(p, 'A provider', 100)),
        skipProviders: list(s.skipProviders, 'skipProviders', p => str(p, 'A provider', 100)),
        stopAtFirst: bool(s.stopAtFirst, 'stopAtFirst'),
        email: email && {
          accept: str(email.accept, 'email.accept', 50) as never, guess: bool(email.guess, 'email.guess'),
          pattern: str(email.pattern, 'email.pattern'),
        },
        outputs: list(s.outputs, 'outputs', o => {
          const x = obj(o, 'An output');
          return { key: str(x.key, 'An output key', 200), path: strOrNull(x.path, 'An output path'),
            columnName: name(x.columnName, 'columnName'), ...(x.fromAnswer === true ? { fromAnswer: true } : {}) };
        }),
        conditions: list(s.conditions ?? [], 'conditions', c => {
          const x = obj(c, 'A condition');
          return { column: name(x.column, 'A condition\'s column'), op: str(x.op, 'A condition', 20) as never,
            value: str(x.value ?? '', 'A condition\'s value') };
        }),
        runIf: strOrNull(s.runIf, 'runIf'), maxCostPerRowUsd: num(s.maxCostPerRowUsd, 'maxCostPerRowUsd'),
        concurrency: int(s.concurrency, 'concurrency'), fresh: bool(s.fresh, 'fresh'), autoRun: autoRun(s.autoRun),
      };
    }
    case 'clean':
      need((CLEANERS as readonly string[]).includes(s.cleaner as string), 'Its cleaner is unknown.');
      return { kind: 'clean', ...base, source: name(s.source, 'source'), cleaner: s.cleaner as string,
        options: cleanOptions(s.options), autoRun: bool(s.autoRun, 'autoRun') };
    default:
      return { kind: 'formula', ...base, formula: str(s.formula, 'formula'),
        description: strOrNull(s.description, 'description'), autoRun: bool(s.autoRun, 'autoRun') };
  }
}

export function readStep(raw: Obj): { ok: SetupStep } | { problem: string } {
  try {
    return { ok: build(raw) };
  } catch (e) {
    if (e instanceof Bad) return { problem: e.message };
    throw e;
  }
}
