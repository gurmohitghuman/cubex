// Pure per-cell transforms for transform_column (non-AI, zero-credit). No DB —
// the service supplies cell values + row data. Kept pure so the ops and the
// ReDoS guard are unit-testable.
import {
  TRANSFORM_MAX_REGEX_LEN, TRANSFORM_REGEX_INPUT_CAP,
} from './api-v1-constants';

export type TransformOp =
  | 'regex_extract' | 'split' | 'template' | 'upper' | 'lower' | 'trim' | 'to_number';

// ReDoS guard. Node's regex engine cannot be interrupted, so one catastrophic
// pattern pins the whole event loop — and transform runs the match INSIDE a
// BEGIN IMMEDIATE txn (services/column-transform.ts), so it would hold the
// SQLite writer lock while it hangs: an app-wide stall from one write-scoped
// token. Two lines of defense, both structural:
//
//   1. This validator: reject a quantifier applied to a group that itself
//      contains a quantifier, AT ANY NESTING DEPTH.
//   2. Cap pattern length AND the input the regex runs against.
//
// This REPLACED a regex-based check (`/\([^)]*[*+|][^)]*\)\s*[*+]/`) that was
// bypassable: `[^)]*` cannot see past an inner ')', so it caught the flat shape
// `(a+)+` but missed every nested one. Measured against the old guard —
// `((a+))+b` ALLOWED, 30-char input → 8.8s, doubling per added character (~35s
// at 32 chars, minutes at 40). The input cap does not help: blowup is
// exponential in LENGTH, so a 32-char cell is already fatal. Do not go back to
// matching this class with a regex — it needs a parse.
//
// The scan is deliberately conservative: it counts a group as "quantified
// inside" if any quantifier appears in it outside a character class, so a few
// safe patterns are rejected too. Rejecting a valid regex costs the user a
// rewrite; accepting a bad one costs everyone the server.
function hasNestedQuantifier(pattern: string): boolean {
  // Depth-indexed: quantifierAt[d] = a quantifier was seen at depth d.
  const quantifierAt: boolean[] = [];
  let depth = 0;
  let inClass = false;

  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') { i++; continue; }          // escaped char — never structural
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; continue; }

    if (c === '(') { depth++; quantifierAt[depth] = false; continue; }

    if (c === ')') {
      const innerHadQuantifier = quantifierAt[depth] === true;
      depth = Math.max(0, depth - 1);
      // Look at what immediately follows the ')': a quantifier here applies to
      // the whole group. Group + inner quantifier = the exponential shape.
      const next = pattern[i + 1];
      const quantified = next === '*' || next === '+' || next === '{';
      if (innerHadQuantifier && quantified) return true;
      // Propagate UP unconditionally when the inner group had a quantifier —
      // even through an UNQUANTIFIED wrapper. Without this, ((a+))+b hides the
      // inner '+' behind the plain middle group and escapes: the middle ')' is
      // followed by ')', not a quantifier, so nothing would mark the parent.
      // The outer '+' then applies to a subtree that repeats. Same for any
      // depth of nesting, e.g. (((a+)))+b.
      if (innerHadQuantifier || quantified || next === '?') quantifierAt[depth] = true;
      continue;
    }

    if (c === '*' || c === '+' || c === '{') {
      if (depth > 0) quantifierAt[depth] = true;
      continue;
    }
    // A top-level alternation inside a group is the (a|a)* shape's ingredient.
    if (c === '|' && depth > 0) { quantifierAt[depth] = true; continue; }
  }
  return false;
}

export function validateRegexPattern(pattern: string): string | null {
  if (typeof pattern !== 'string' || pattern === '') return 'pattern is required for regex_extract.';
  if (pattern.length > TRANSFORM_MAX_REGEX_LEN) return `pattern too long (max ${TRANSFORM_MAX_REGEX_LEN} chars).`;
  if (hasNestedQuantifier(pattern)) {
    return 'pattern rejected: a repeated group that itself repeats risks catastrophic backtracking. '
      + 'Simplify the regex (e.g. "(\\w+)+" → "\\w+").';
  }
  try { new RegExp(pattern); } catch (e) { return `invalid regex: ${(e as Error).message}`; }
  return null;
}

// Coerce to a canonical numeric string (same rule as multi-output number cells):
// numeric → its string form, else '' — so it stays sortable + where-filterable.
function toNumberString(value: string): string {
  const t = value.trim();
  return t !== '' && Number.isFinite(Number(t)) ? t : '';
}

// regex_extract: capture group 1 (or the whole match if no group). No match → ''.
// Input is capped before matching as the second ReDoS defense.
function regexExtract(value: string, pattern: string): string {
  const re = new RegExp(pattern);
  const m = re.exec(value.slice(0, TRANSFORM_REGEX_INPUT_CAP));
  if (!m) return '';
  return (m[1] ?? m[0]) ?? '';
}

// Apply a single-cell op (everything except template, which needs the whole row).
export function applyCellOp(
  op: Exclude<TransformOp, 'template'>, value: string,
  params: { pattern?: string; index?: number },
): string {
  switch (op) {
    case 'upper': return value.toUpperCase();
    case 'lower': return value.toLowerCase();
    case 'trim': return value.trim();
    case 'to_number': return toNumberString(value);
    case 'regex_extract': return regexExtract(value, params.pattern ?? '');
    case 'split': {
      const parts = value.split(params.pattern ?? '');
      const idx = params.index ?? 0;
      return parts[idx] ?? '';
    }
  }
}

// template: substitute {{column}} tokens from the whole row. An unknown column
// substitutes '' (blank), matching the HTTP request-template convention (not a
// "[MISSING]" marker).
export function applyTemplate(template: string, data: Record<string, string>): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, col: string) =>
    Object.prototype.hasOwnProperty.call(data, col) ? (data[col] ?? '') : '');
}
