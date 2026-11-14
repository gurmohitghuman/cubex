// Plain words for what a tool call's arguments got wrong (error-answers.ts). The SDK refuses arguments that
// don't fit a tool's inputSchema in the schema library's words ("Invalid input: expected string, received
// number"), and a tools/call request that isn't one with the raw list of issues. Here each issue names the
// field, what it takes (its type, range or choices, as tools/list publishes them) and what was sent. A
// message a schema sets itself (lenientInt's) stays as it is, after its field, as the SDK shows it.
import type { z } from 'zod';

type Json = Record<string, any>;
type Key = string | number | symbol;
export interface Issue {
  code: string; path: Key[]; message: string; expected?: string; values?: unknown[]; format?: string;
  keys?: string[]; divisor?: number; minimum?: number | string; maximum?: number | string; origin?: string;
  errors?: Issue[][];
}

// What the library's own words become: a mark, replaced here. A schema's own message takes precedence.
const MARK = '\u0000';
const TYPE_WORDS: Record<string, string> = {
  string: 'text', number: 'a number', integer: 'a whole number', boolean: 'true or false', array: 'a list',
  object: 'an object', record: 'an object', null: 'null',
};
const FORMAT_WORDS: Record<string, string> = {
  url: 'a URL such as https://example.com/a', email: 'an email address', uuid: 'an id in UUID form',
  datetime: 'a date and time such as 2026-01-31T09:30:00Z', date: 'a date such as 2026-01-31',
};

const cut = (s: string) => (s.length > 40 ? `${s.slice(0, 37)}...` : s);
function sent(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return v === '' ? 'empty text' : `text ${JSON.stringify(cut(v))}`;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return Array.isArray(v) ? `a list of ${v.length}` : 'an object';
}

// The published schema of the field at path (properties, list items, the branch that has it).
function nodeAt(root: Json | null, path: Key[]): Json | null {
  let node: Json | null = root;
  for (const key of path) {
    if (!node) return null;
    const branches: Json[] = node.anyOf ?? node.oneOf ?? [node];
    node = branches.map(b => (typeof key === 'number' ? b.items : b.properties?.[String(key)]))
      .find(n => n && typeof n === 'object') ?? null;
  }
  return node;
}
const valueAt = (args: unknown, path: Key[]): unknown => path.reduce<unknown>((v, key) =>
  (v && typeof v === 'object' ? (v as Record<Key, unknown>)[key] : undefined), args);

// A range in words; a bound at the largest safe integer is none (lenientInt's open end). unit: "character".
const SAFE = Number.MAX_SAFE_INTEGER;
function between(lo: unknown, hi: unknown, unit = ''): string {
  const low = typeof lo === 'number' && lo > -SAFE ? lo : undefined;
  const high = typeof hi === 'number' && hi < SAFE ? hi : undefined;
  const of = (n: number) => (unit ? ` ${unit}${n === 1 ? '' : 's'}` : '');
  if (low !== undefined && high !== undefined) return ` from ${low} to ${high}${of(high)}`;
  if (low !== undefined) return unit ? ` of at least ${low}${of(low)}` : ` of ${low} or more`;
  return high !== undefined ? ` of at most ${high}${of(high)}` : '';
}

// What a field takes, in words: "a whole number from 1 to 1000", "one of "a", "b"", "text or a list".
export function wants(node: Json | null): string {
  if (!node) return '';
  if (Array.isArray(node.enum)) return `one of ${node.enum.map(v => JSON.stringify(v)).join(', ')}`;
  if (node.const !== undefined) return JSON.stringify(node.const);
  const branches: Json[] | undefined = node.anyOf ?? node.oneOf;
  if (branches) return [...new Set(branches.map(wants).filter(Boolean))].join(' or ');
  const types: string[] = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
  return types.map(t => {
    const words = TYPE_WORDS[t] ?? t;
    if (t === 'number' || t === 'integer') return words + between(node.minimum, node.maximum);
    if (t === 'string') return words + between(node.minLength, node.maxLength, 'character');
    if (t === 'array') return words + between(node.minItems, node.maxItems, 'item');
    return words;
  }).join(' or ');
}

// One issue in plain words. known: what was sent is in args (a request's issues come without it, and only
// the library's words say what type it was).
export function plainIssue(issue: Issue, root: Json | null, args: unknown, known = true): string {
  const path = issue.path.map(String).join('.');
  if (known && issue.message !== MARK) return path ? `${path}: ${issue.message}` : issue.message;
  const field = path || 'The arguments';
  const node = nodeAt(root, issue.path);
  const value = known ? valueAt(args, issue.path) : undefined;
  const missing = known ? value === undefined : /received undefined/.test(issue.message);
  const was = known ? (missing ? '' : sent(value))
    : TYPE_WORDS[/received (\w+)/.exec(issue.message)?.[1] ?? ''] ?? '';
  const not = was ? `, not ${was}` : '';
  const want = wants(node) || TYPE_WORDS[issue.expected ?? ''] || issue.expected || 'something else';
  switch (issue.code) {
    case 'invalid_type': {
      if (!missing) return `${field} must be ${want}${not}.`;
      const about = typeof node?.description === 'string' && node.description.length <= 120
        ? `: ${node.description.replace(/\.$/, '')}` : '';
      return `${field} is required (${want})${about}.`;
    }
    case 'invalid_value':
      return `${field} must be one of ${(issue.values ?? []).map(v => JSON.stringify(v)).join(', ')}${not}.`;
    case 'invalid_format':
      return `${field} must be ${FORMAT_WORDS[issue.format ?? ''] ?? `in ${issue.format} form`}${not}.`;
    case 'unrecognized_keys': {
      const names = (issue.keys ?? []).map(k => JSON.stringify(k)).join(', ');
      const takes = Object.keys(node?.properties ?? {}).join(', ');
      return `${path ? `${path} has` : 'This tool takes'} no field ${names}${takes ? ` (it takes ${takes})` : ''}.`;
    }
    case 'not_multiple_of': return `${field} must be a multiple of ${issue.divisor}${not}.`;
    case 'invalid_union': {
      // A value of the right kind for some form, wrong inside it: what that form got wrong (the form with
      // the fewest problems). Wrong for every form at its own level: the forms it takes.
      const inside = (issue.errors ?? []).filter(e => e.length && e.some(i => i.path.length))
        .sort((a, b) => a.length - b.length)[0];
      const deeper = (i: Issue) => plainIssue({ ...i, path: [...issue.path, ...i.path] }, root, args, known);
      if (inside) return inside.map(deeper).join(' ');
      return `${field} must be ${want}${not}.`;
    }
    default: return `${field} must be ${want}${not}.`;
  }
}

// The issues with the arguments a tool was called with, in plain words; null when they fit.
export function plainArgumentErrors(schema: z.ZodType, args: unknown): string[] | null {
  const parsed = schema.safeParse(args ?? {}, { error: () => MARK });
  if (parsed.success) return null;
  let root: Json | null = null;
  try {
    root = (schema['~standard'] as unknown as { jsonSchema: { input: (o: object) => Json } })
      .jsonSchema.input({ target: 'draft-2020-12' });
  } catch { /* words from the issue alone */ }
  return parsed.error.issues.map(i => plainIssue(i as unknown as Issue, root, args));
}

// The SDK's refusal of a request that isn't one ("Invalid tools/call request: [...issues as JSON]"), in
// plain words; null for any other message.
export function plainRequestError(message: string): string | null {
  const m = /^(Invalid \S+ request): (\[[\s\S]*\])$/.exec(message);
  if (!m) return null;
  try {
    const issues = JSON.parse(m[2]) as Issue[];
    if (!Array.isArray(issues) || !issues.length) return null;
    return `${m[1]}: ${issues.map(i => plainIssue({ ...i, path: i.path ?? [] }, null, undefined, false)).join(' ')}`;
  } catch {
    return null;
  }
}
