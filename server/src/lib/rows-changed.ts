// How many times each sheet's rows were added to or removed on this server since it started, counted in memory.
// Every statement that inserts or deletes rows calls rowsChanged with its sheet, in the same synchronous step
// (tests/unit/rows-changed-guard.test.ts finds every one). A sheet's row count (lib/row-counts.ts) is known only
// while this number, and the sheet's data_version and row_generation, are what they were when it was counted.
// Nothing here touches the database, so a write pays nothing for it. Runs' worker threads add or remove no rows.
const changed = new Map<string, number>();

export function rowsChanged(sheetId: string): void {
  changed.set(sheetId, (changed.get(sheetId) ?? 0) + 1);
}

export const rowsChangedOf = (sheetId: string): number => changed.get(sheetId) ?? 0;
