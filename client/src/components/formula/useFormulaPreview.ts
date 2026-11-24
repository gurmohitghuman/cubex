import { formulaAPI, type FormulaColumnBody, type FormulaPreviewResult } from '@/utils/api'
import { usePreviewRead, type PreviewState } from '@/hooks/useTypedReads'

// The newest answer (kept on screen while the next one loads), or the server's reason the formula can't be used
// (a syntax error, an unknown column, a name clash).
export type FormulaPreviewState = PreviewState<FormulaPreviewResult>

// The Formula dialog's preview: as the formula is typed, the server runs it on the first rows that hold a value
// (a pure read, free), one read at a time, an older answer never shown (hooks/useTypedReads.ts). body null:
// nothing to preview yet.
export const useFormulaPreview = (sheetId: string, body: FormulaColumnBody | null): FormulaPreviewState =>
  usePreviewRead(sheetId, body, formulaAPI.preview, "Couldn't load the preview.")
