// List results into rows: a list job's request part, its progress and the
// fields its results have. Mirrors server/src/lib/enrich-list-input.ts,
// services/enrich-list-fields.ts and enrich-run-status.ts. Re-exported from './types'.

// A field of a result (its path inside one result) and the column it fills.
export interface EnrichListField { path: string; columnName: string }

// The list part of a run start: where the rows go, the one provider asked,
// results per row, the fields kept (null: picked after the test run), the
// source columns copied into each row, and the duplicate check.
export interface EnrichListRequest {
  dest: { sheetId: string } | { newSheetName: string }
  provider: string | null
  maxItems: number
  fields: EnrichListField[] | null
  copy: Array<{ from: string; to: string }>
  dedupePath: string | null
}

export interface EnrichListEstimate {
  addUpTo: number      // rows x results per row
  perRow: number
  destRows: number     // rows the destination has now (0 for a new sheet)
  maxRows: number
}

export interface EnrichListProgress {
  destSheetId: string | null
  destName: string | null
  maxItems: number
  fieldsPicked: boolean
  added: number
  adding: { rows: number; results: number }
  waitingFields: { rows: number; results: number }
  waitingRoom: { rows: number; results: number }
}

// A field the results have, how many fill it, and one value.
export interface EnrichListFieldInfo { path: string; label: string; filled: number; sample: string }

export interface EnrichListFieldChoices {
  fields: EnrichListFieldInfo[]
  results: number
  waiting: { rows: number; results: number }
  kept: EnrichListField[] | null
  dedupePath: string | null
  destSheetId: string | null
}
