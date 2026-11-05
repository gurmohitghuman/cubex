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
