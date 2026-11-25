// Why a row doesn't pass an "Only run if" rule (pure), in plain words: each part of the rule that failed, with
// what the cell holds and what the rule needs ('Country is "DE"; the rule needs it to be "US".'). Exact and free:
// it walks the same tree rulePasses checks (lib/run-condition.ts), with the same comparison. A NOT is pushed down
// to the comparisons under it, so each reason names one comparison. [] when the row passes.
import { cellOf } from './row-cell';
import { holdsRunMarker } from './run-markers';
import { asDate } from './row-filter/dates';
import { asNumber } from './row-filter/ops';
import { comparePasses, type RuleNode } from './run-condition';
import type { Compare, CompareOp } from './run-condition-parse';

// A comparison's opposite, for words only (whether it passed is always checked on the comparison itself).
const OPPOSITE: Record<CompareOp, CompareOp> = {
  is: 'is_not', is_not: 'is', contains: 'not_contains', not_contains: 'contains', empty: 'not_empty',
  not_empty: 'empty', gt: 'lte', lt: 'gte', gte: 'lt', lte: 'gt', on: 'not_on', not_on: 'on',
  before: 'on_or_after', after: 'on_or_before', on_or_before: 'after', on_or_after: 'before',
};
const NUMBER_OPS = new Set<CompareOp>(['gt', 'lt', 'gte', 'lte']);
const DATE_OPS = new Set<CompareOp>(['on', 'not_on', 'before', 'after', 'on_or_before', 'on_or_after']);

const quoted = (v: string) => `"${v}"`;

// What the rule needs of the cell, after "the rule needs it ".
function needs(op: CompareOp, value: string): string {
  switch (op) {
    case 'is': return `to be ${quoted(value)}`;
    case 'is_not': return `not to be ${quoted(value)}`;
    case 'contains': return `to contain ${quoted(value)}`;
    case 'not_contains': return `not to contain ${quoted(value)}`;
    case 'empty': return 'to be empty';
    case 'not_empty': return 'to have a value';
    case 'gt': return `to be a number above ${value}`;
    case 'lt': return `to be a number below ${value}`;
    case 'gte': return `to be a number of ${value} or more`;
    case 'lte': return `to be a number of ${value} or less`;
    case 'on': return `to be the date ${value}`;
    case 'not_on': return `to be a date other than ${value}`;
    case 'before': return `to be a date before ${value}`;
    case 'after': return `to be a date after ${value}`;
    case 'on_or_before': return `to be a date on or before ${value}`;
    case 'on_or_after': return `to be a date on or after ${value}`;
  }
}

// A part that failed: its sentence, and the short form an OR lists.
interface Miss { full: string; short: string }

function reason(c: Compare, data: Record<string, string>, negated: boolean): Miss {
  const raw = String(cellOf(data, c.column) ?? '');
  const cell = holdsRunMarker(raw) ? '' : raw.trim();
  const op = negated ? OPPOSITE[c.op] : c.op;
  const has = cell === '' ? 'is empty'
    : NUMBER_OPS.has(op) && asNumber(cell) === null ? `is ${quoted(cell)}, not a number`
      : DATE_OPS.has(op) && asDate(cell) === null ? `is ${quoted(cell)}, not a date`
        : `is ${quoted(cell)}`;
  const need = needs(op, c.value);
  return { full: `${c.column} ${has}; the rule needs it ${need}.`, short: `${c.column} ${has} (it needs ${need})` };
}

function misses(node: RuleNode, data: Record<string, string>, negated: boolean): Miss[] {
  if (node.kind === 'cmp') return comparePasses(node, data) !== negated ? [] : [reason(node, data, negated)];
  if (node.kind === 'not') return misses(node.item, data, !negated);
  const parts = node.items.map(item => misses(item, data, negated));
  // AND (or a NOT over OR): every part must hold, so each part that failed is a reason.
  if ((node.kind === 'and') !== negated) return parts.flat();
  // OR (or a NOT over AND): one part was enough; it fails only when none held, said as one reason.
  if (parts.some(p => p.length === 0)) return [];
  const each = parts.map(p => p.map(m => m.short).join(' and '));
  return [{ full: `None of these held: ${each.join(', or ')}.`, short: `none of these held: ${each.join(', or ')}` }];
}

export function ruleMisses(tree: RuleNode, data: Record<string, string>): string[] {
  return misses(tree, data, false).map(m => m.full);
}
