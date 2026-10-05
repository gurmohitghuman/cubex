import {
  CellStyleModule, ClientSideRowModelModule, ColumnApiModule, LargeTextEditorModule,
  ModuleRegistry, RowApiModule, RowSelectionModule, ScrollApiModule, TextEditorModule,
  TextFilterModule,
} from 'ag-grid-community'

// The AG Grid modules the sheet grid actually uses (imported for its side
// effect by AGGridSpreadsheet). AllCommunityModule pulled in ~60 modules (CSV
// export, pagination, number/date editors, infinite row model, validation…),
// most of the aggrid chunk. Column move, resize, pinned columns and keyboard
// navigation are always-on core, so they need no entry here.
//
// A missing module fails QUIETLY: the API call returns undefined and our
// `?? []` fallbacks swallow it (column order would stop syncing, no error). So
// when the grid starts using a new option or API method, add its module here.
// The option → module map is AG Grid's COLUMN_DEFINITION_MOD_VALIDATIONS /
// GRID_OPTIONS_MODULES; the API → module map is gridApiFunctionsMap.
ModuleRegistry.registerModules([
  ClientSideRowModelModule, // rowData
  LargeTextEditorModule,    // cellEditor: 'agLargeTextCellEditor' (popup), stopEditing
  TextEditorModule,         // AG Grid's default editor for any editable column without one
  RowSelectionModule,       // rowSelection, deselectAll, getSelectedNodes
  CellStyleModule,          // cellStyle
  ColumnApiModule,          // getColumnState, applyColumnState
  RowApiModule,             // getLastDisplayedRowIndex
  ScrollApiModule,          // ensureIndexVisible
  // filter: true. Filtering itself is server-side and the custom header never
  // opens AG Grid's filter popup, but the filter service also drives the
  // header's screen-reader description, so it stays registered.
  TextFilterModule,
])
