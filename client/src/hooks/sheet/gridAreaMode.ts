// What SheetPage's grid AREA shows: the loader, the import-CSV empty state, or
// the grid itself.
//
// NOTE: SheetPage does NOT early-return a FullPageLoader on isLoading — that
// unmounts the whole page (header + bottom sheet-tab bar included), so switching
// a tab flashes the entire chrome away and back. Instead the loader is scoped to
// the grid AREA, keeping the header + tab bar mounted across a sheet switch
// (keep the switch loud but make the loading UI local to the
// grid, don't bend silent-reload to a cross-sheet job). initialLoad (no data yet)
// still shows the full loader.
export type GridAreaMode = 'loading' | 'import' | 'grid'

export function gridAreaMode(
  isLoading: boolean,
  totalDisplayedRows: number,
  emptyFilter: Record<string, unknown>,
  columnFilters: Record<string, unknown>,
): GridAreaMode {
  // Show the grid loader while a load is in flight. selectSheet sets isLoading=true
  // SYNCHRONOUSLY with setActiveSheet (see useSheetOps), so there's no one-frame window
  // where the new tab is active but isLoading is still false — the loader is already up
  // before the grid could paint the old sheet's rows. On load failure the load's finally
  // clears isLoading (so no stuck loader). Header + tab bar stay mounted (no full flash).
  if (isLoading) return 'loading'

  // The import-CSV empty state replaces the whole grid (header + filter menu
  // included), so it must show ONLY when the sheet is GENUINELY empty — never
  // when a server-side empty filter merely hides every row. Otherwise filtering
  // a column to "empty" and deleting those rows leaves zero filtered rows, drops
  // the user to "Ready for data", and there's no UI left to clear the filter and
  // reveal the surviving non-empty rows. With a filter active we keep SheetGrid
  // mounted, so AGGridSpreadsheet's own zero-row branch renders its "All rows are
  // hidden by a column filter" message with a Clear filter button (that branch was
  // otherwise unreachable — this page short-circuited to the import state first).
  // Any active filter (empty OR text-contains) must keep the grid mounted when it
  // hides every row, so the header menu (the only clear-filter UI) stays reachable.
  const hasActiveEmptyFilter = Object.keys(emptyFilter).length > 0 || Object.keys(columnFilters).length > 0
  // Key off the TRUE total, NOT the loaded-window length: deleting the loaded
  // window of a large sheet leaves rows.length 0 while rows remain server-side, and
  // the old `!rows.length` wrongly flipped to the import state (hiding survivors the
  // refill hook then reloads). totalRows is the FILTERED total, so the
  // `!hasActiveEmptyFilter` guard still separates "genuinely empty" from "filter
  // hides all" (latter keeps SheetGrid mounted for its Clear-filter branch).
  if (totalDisplayedRows === 0 && !hasActiveEmptyFilter) return 'import'

  return 'grid'
}
