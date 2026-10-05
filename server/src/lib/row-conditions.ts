// Text conditions for row selection (services/row-selection.ts): the `where`
// filters on MCP / API reads, row transfers and CSV exports. Pure string logic:
// values are trimmed and case-folded, and a missing cell reads as '' (so it
// passes 'empty' and fails 'not_empty'). Numeric operators live in
// row-selection.ts.
export type TextConditionOp = 'eq' | 'neq' | 'contains' | 'empty' | 'not_empty';

// True = the row PASSES the condition.
export function passesCondition(
  rawValue: string | null | undefined,
  op: TextConditionOp,
  value: string | null,
): boolean {
  const c = (rawValue ?? '').toString().trim().toLowerCase();
  const v = (value ?? '').trim().toLowerCase();
  switch (op) {
    case 'eq': return c === v;
    case 'neq': return c !== v;
    case 'contains': return c.includes(v);
    case 'empty': return c === '';
    case 'not_empty': return c !== '';
  }
}
