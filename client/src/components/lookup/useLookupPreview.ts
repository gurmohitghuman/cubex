import { lookupAPI, type LookupColumnBody, type LookupPreviewResult } from '@/utils/api'
import { usePreviewRead, type PreviewState } from '@/hooks/useTypedReads'

// The newest answer (kept on screen while the next one loads), or the server's reason the lookup can't be set up
// so (a column gone, a name clash).
export type LookupPreviewState = PreviewState<LookupPreviewResult>

// The Lookup dialog's preview: as the settings change, the server looks up the first rows that hold a value (a
// pure read, free), one read at a time, an older answer never shown (hooks/useTypedReads.ts). A pick reads at
// once, typing after a pause (lib/typingWait.ts). body null: nothing to preview yet.
export const useLookupPreview = (sheetId: string, body: LookupColumnBody | null): LookupPreviewState =>
  usePreviewRead(sheetId, body, lookupAPI.preview, "Couldn't load the preview.")
