// "Only run if" rules on AI, HTTP API and enrichment runs (pure). A rule is
// text (lib/run-condition-parse.ts has the language); a run keeps it as
// written by checkRule, with every column named exactly as in the sheet. Each
// row is checked against it without any AI: a row that fails gets
// "⏭️ Condition not met" instead of a run, and costs nothing.
import { normalizeColumnName } from './prompt';
import { holdsRunMarker } from './run-markers';
import { parseRule, RuleError, MAX_RULE_CHARS, type Compare, type RuleNode } from './run-condition-parse';
import type { EnrichCondition } from './enrich-run-config';

export { RuleError, MAX_RULE_CHARS } from './run-condition-parse';
export type { RuleNode } from './run-condition-parse';

export interface CheckedRule { rule: string; tree: RuleNode; columns: string[] }

function eachCompare(node: RuleNode, visit: (c: Compare) => void): void {
  if (node.kind === 'cmp') visit(node);
  else if (node.kind === 'not') eachCompare(node.item, visit);
  else node.items.forEach(n => eachCompare(n, visit));
}

// The sheet column a reference means: its exact name, else the one name it
// matches ignoring case, else the one whose normalized form matches.
function resolveColumn(ref: string, columns: string[]): string | null {
  if (columns.includes(ref)) return ref;
  const lower = columns.filter(c => c.toLowerCase() === ref.toLowerCase());
  if (lower.length === 1) return lower[0];
  const norm = columns.filter(c => normalizeColumnName(c) === normalizeColumnName(ref));
  return norm.length === 1 ? norm[0] : null;
}

const quote = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const OP_TEXT: Record<Compare['op'], string> = {
  is: 'is', is_not: 'is not', contains: 'contains', not_contains: 'does not contain',
  empty: 'is empty', not_empty: 'is not empty', gt: '>', lt: '<', gte: '>=', lte: '<=',
};

// The rule as Cubex writes it back: one spelling per operator, AND/OR/NOT in
// capitals, brackets only where they change the meaning (and around NOT's).
export function formatRule(node: RuleNode): string {
  if (node.kind === 'cmp') {
    const left = `{{${node.column}}} ${OP_TEXT[node.op]}`;
    if (node.op === 'empty' || node.op === 'not_empty') return left;
    return `${left} ${node.numeric ? node.value : quote(node.value)}`;
  }
  if (node.kind === 'not') return `NOT (${formatRule(node.item)})`;
  const word = node.kind === 'and' ? ' AND ' : ' OR ';
  return node.items.map(n => (n.kind === 'or' && node.kind === 'and' ? `(${formatRule(n)})` : formatRule(n)))
    .join(word);
}

// Parse a rule against the sheet's columns: every reference resolved to its
// column (a misspelled one is refused with the closest name), then written
// back in Cubex's own spelling. Throws RuleError with a message for the user.
export function checkRule(text: string, sheetColumns: string[]): CheckedRule {
  if (text.length > MAX_RULE_CHARS) throw new RuleError(`A rule can be at most ${MAX_RULE_CHARS} characters.`);
  const tree = parseRule(text.trim());
  const used = new Set<string>();
  eachCompare(tree, c => {
    const col = resolveColumn(c.column, sheetColumns);
    if (!col) throw new RuleError(`There's no column named "${c.column}".${suggest(c.column, sheetColumns)}`);
    if (col.includes('}}')) throw new RuleError(`"${col}" can't be used in a rule: rename it without "}}".`);
    c.column = col;
    used.add(col);
  });
  return { rule: formatRule(tree), tree, columns: [...used] };
}

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// The column a misspelled reference most likely meant: one containing it (or
// contained in it), else the nearest by a few typos.
function suggest(ref: string, columns: string[]): string {
  const n = normalizeColumnName(ref);
  const scored = columns.map(c => {
    const cn = normalizeColumnName(c);
    return { c, d: cn.includes(n) || n.includes(cn) ? 0 : distance(n, cn) };
  }).filter(x => x.d <= Math.max(2, Math.floor(n.length / 4))).sort((a, b) => a.d - b.d);
  return scored.length ? ` Did you mean "${scored[0].c}"?` : '';
}

// The columns a stored rule reads, without the sheet (a deleted column stays
// listed, so a run can say it's gone). A rule that no longer parses reads none.
export function ruleColumns(rule: string): string[] {
  try {
    const out = new Set<string>();
    eachCompare(parseRule(rule), c => out.add(c.column));
    return [...out];
  } catch {
    return [];
  }
}

const asNumber = (raw: string): number | null => {
  const t = raw.trim().replace(/,/g, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

function comparePasses(c: Compare, data: Record<string, string>): boolean {
  const raw = data[c.column] ?? '';
  const cell = holdsRunMarker(raw) ? '' : raw.toString().trim();
  const text = cell.toLowerCase(), want = c.value.trim().toLowerCase();
  switch (c.op) {
    case 'empty': return cell === '';
    case 'not_empty': return cell !== '';
    case 'contains': return text.includes(want);
    case 'not_contains': return !text.includes(want);
    case 'is': case 'is_not': {
      const a = c.numeric ? asNumber(cell) : null, b = c.numeric ? asNumber(c.value) : null;
      const same = a !== null && b !== null ? a === b : text === want;
      return c.op === 'is' ? same : !same;
    }
    default: {
      const a = asNumber(cell), b = asNumber(c.value);
      if (a === null || b === null) return false;
      return c.op === 'gt' ? a > b : c.op === 'lt' ? a < b : c.op === 'gte' ? a >= b : a <= b;
    }
  }
}

// True = the row runs. Text compares ignore case and outer spaces; a cell
// holding a run's own word (⏳, ❌, ⏭️, ➕) reads as empty; >, <, >= and <=
// need a number on both sides (commas allowed), else the check fails.
export function rulePasses(tree: RuleNode, data: Record<string, string>): boolean {
  if (tree.kind === 'cmp') return comparePasses(tree, data);
  if (tree.kind === 'not') return !rulePasses(tree.item, data);
  return tree.kind === 'and' ? tree.items.every(n => rulePasses(n, data)) : tree.items.some(n => rulePasses(n, data));
}

// Column rename: the rule reading the new name. A rule that doesn't parse is
// left as it is (its run reports it), and so is one the new name can't be
// written into ("}}" ends a reference): it then names a column that's gone,
// which a run reports and auto-run pauses on.
export function renameRuleColumn(rule: string, oldName: string, newName: string): string {
  if (newName.includes('}}')) return rule;
  try {
    const tree = parseRule(rule);
    let changed = false;
    eachCompare(tree, c => { if (c.column === oldName) { c.column = newName; changed = true; } });
    return changed ? formatRule(tree) : rule;
  } catch {
    return rule;
  }
}

// A request's rule field: text, or nothing (null/undefined/blank = every row).
export function parseRuleField(raw: unknown, field = 'runIf'): { ok: string | null } | { error: string } {
  if (raw === undefined || raw === null) return { ok: null };
  if (typeof raw !== 'string') return { error: `${field} must be text, like {{Industry}} is "SaaS".` };
  if (raw.length > MAX_RULE_CHARS) return { error: `${field} can be at most ${MAX_RULE_CHARS} characters.` };
  return { ok: raw.trim() === '' ? null : raw };
}

// Enrichments saved before rules had a list of conditions, all of which had
// to pass: the same thing as a rule.
export function ruleFromConditions(where: EnrichCondition[]): string | null {
  if (where.length === 0) return null;
  const ops: Record<EnrichCondition['op'], Compare['op']> = {
    eq: 'is', neq: 'is_not', contains: 'contains', empty: 'empty', not_empty: 'not_empty', gt: 'gt', lt: 'lt',
  };
  const items: Compare[] = where.map(c => ({
    kind: 'cmp', column: c.column, op: ops[c.op], value: c.value ?? '',
    // Written bare only when the parser reads it back as a number ("1,000"
    // stays quoted; > and < compare it as a number either way).
    numeric: (c.op === 'gt' || c.op === 'lt') && /^-?\d+(\.\d+)?$/.test((c.value ?? '').trim()),
    ...((c.op === 'gt' || c.op === 'lt') ? { value: (c.value ?? '').trim() } : {}),
  }));
  return formatRule(items.length === 1 ? items[0] : { kind: 'and', items });
}
