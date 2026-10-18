import { api } from './client'

// The grid's search and value counts (server routes/sheets-search.ts). Every
// call takes an AbortSignal: a newer keystroke (or a closed menu) cancels the
// one in flight, and the server stops walking the sheet.
export interface SearchCell { row: number; column: string }
export interface SearchMatch extends SearchCell { position: number }
interface Versions { data_version: number; row_generation: number }
export interface SearchFound extends Versions { match: SearchMatch | null; wrapped: boolean }
export interface SearchCount extends Versions { total: number; capped: boolean; before: number | null }
export interface ValueCountsAnswer {
  values: Array<{ value: string; count: number }>
  empty: number
  distinct: number
  rows: number
  truncated: boolean
}
// tooMany: more different values than counting holds; busy: a big job holds the sheet.
export type ValueCountsResult = ValueCountsAnswer | { tooMany: true; error: string } | { busy: true; error: string }

const quiet = { skipServerErrorToast: true } as const

export const searchAPI = {
  // from: the current match (with its position and the versions it was read
  // at) or the focused cell (inclusive: it may match itself).
  find: (sheetId: string, q: string, opts: {
    from?: SearchCell & { position?: number }; versions?: Versions; inclusive?: boolean; back?: boolean
    viewId?: string | null; signal?: AbortSignal
  }): Promise<SearchFound> => api.get(`/sheets/${sheetId}/search`, {
    params: {
      q, view: opts.viewId ?? undefined, row: opts.from?.row, column: opts.from?.column,
      position: opts.from?.position, inclusive: opts.inclusive ? 1 : undefined, back: opts.back ? 1 : undefined,
      dv: opts.versions?.data_version, rg: opts.versions?.row_generation,
    },
    signal: opts.signal, ...quiet,
  }).then(res => res.data),

  count: (sheetId: string, q: string, opts: { at?: SearchCell; viewId?: string | null; signal?: AbortSignal }):
    Promise<SearchCount> => api.get(`/sheets/${sheetId}/search/count`, {
    params: { q, view: opts.viewId ?? undefined, row: opts.at?.row, column: opts.at?.column },
    signal: opts.signal, ...quiet,
  }).then(res => res.data),

  values: (sheetId: string, column: string, signal?: AbortSignal): Promise<ValueCountsResult> =>
    api.get(`/sheets/${sheetId}/values`, { params: { column }, signal, ...quiet }).then(res => res.data),
}
