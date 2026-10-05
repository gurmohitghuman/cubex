import { db } from '../lib/db';

// Optional row_generation fence for the UI rerun routes (ai-run-rerun.ts,
// http-run-rerun.ts). "Run Selected Rows" targets by row_index, so a physical
// sort or CSV-replace elsewhere between the user's selection and the rerun
// request re-means every index — the rerun would then stamp placeholders and
// overwrite output on the WRONG logical rows. When the client sends the
// row_generation it loaded (rowGenerationRef), reject a mismatch with a 409 the
// client already knows how to recover from (reload + toast). An omitted
// generation SKIPS the check (back-compat, same posture as PUT /:id/data — the
// stable-id /api/v1 rerun path is generation-immune and never sends it).
//
// Returns a 409 response body on conflict, or null when clear (or skipped).
export function rerunRowGenerationConflict(
  sheetId: string,
  userId: string,
  body: unknown,
): { error: string; currentGeneration: number } | null {
  const clientGen = (body as { rowGeneration?: unknown })?.rowGeneration;
  if (typeof clientGen !== 'number') return null; // omitted → skip (back-compat)

  const cur = db.prepare('SELECT row_generation FROM sheets WHERE id = ? AND user_id = ?')
    .get(sheetId, userId) as { row_generation: number } | undefined;
  if (cur && cur.row_generation !== clientGen) {
    return {
      error: 'This sheet was reordered elsewhere. Reload before re-running selected rows.',
      currentGeneration: cur.row_generation,
    };
  }
  return null;
}
