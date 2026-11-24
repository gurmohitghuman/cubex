import { cleanAPI, type CleanColumnBody, type CleanPreviewResult } from '@/utils/api'
import { usePreviewRead, type PreviewState } from '@/hooks/useTypedReads'

// The newest answer (kept on screen while the next one loads), or the server's reason the setup can't be used
// (a name clash, an unknown column, a bad country).
export type CleanPreviewState = PreviewState<CleanPreviewResult>

// The Clean data dialog's preview: as the form changes, the server cleans the first rows that hold a value (a pure
// read, free), one read at a time, an older answer never shown (hooks/useTypedReads.ts). A pick reads at once;
// the column's name and the phone country are typed. body null: nothing to preview yet.
export const useCleanPreview = (sheetId: string, body: CleanColumnBody | null): CleanPreviewState =>
  usePreviewRead(sheetId, body, cleanAPI.preview, "Couldn't load the preview.",
    b => [b.column, b.options?.phoneCountry])
