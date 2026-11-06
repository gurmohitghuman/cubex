// Reading one cell of a row's data. column_order lists a sheet's columns and a
// row holds only the keys it has values for, so a listed column the row has no
// key for is an empty cell. Row data is plain JSON.parse output: a missing
// "constructor" or "toString" key would otherwise read the member an object
// inherits (a function, which every check takes for a filled cell).

// Whether the row holds its own value for the column.
export const hasCell = (data: object, column: string): boolean =>
  Object.prototype.hasOwnProperty.call(data, column);

// The row's own value for the column, '' when it holds none.
export const cellOf = (data: Record<string, string>, column: string): string =>
  hasCell(data, column) ? data[column] ?? '' : '';

// Cells read as json_extract picks (a raw SQL row): columns[i] is picked[from + i],
// NULL as ''. A null-prototype record: a column named "__proto__" keeps its value
// (a plain object's setter drops it) and a missing "constructor" reads undefined.
export function pickedCells(
  columns: readonly string[], picked: readonly unknown[], from: number,
): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  columns.forEach((c, i) => { const v = picked[from + i]; out[c] = v == null ? '' : String(v); });
  return out;
}
