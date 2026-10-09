// How a column still filling from stored answers reads (pure): every cell
// says processing until the fill is done (lib/field-fill-columns.ts).
export const FILL_PLACEHOLDER = '⏳ Processing...';

// The rows' cells in those columns read as processing (in place). columns: a
// read of only some columns leaves the others out.
export function overlayFilling(
  rows: Array<{ data?: Record<string, string> }>, filling: string[], columns?: string[],
): void {
  const shown = columns ? filling.filter(c => columns.includes(c)) : filling;
  if (shown.length === 0) return;
  for (const r of rows) if (r.data) for (const c of shown) r.data[c] = FILL_PLACEHOLDER;
}
