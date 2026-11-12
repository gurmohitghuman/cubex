// What a delete answers over REST and MCP: where the rows (or the sheet,
// table or column) went, until when, and how to get them back. A deleted
// column's answer also says whether its cells are all in the trash ('kept') or
// still going there ('moving': services/column-delete.ts stopped waiting).
import { db } from '../lib/db';
import { getTrashDays, trashExpiry } from '../lib/trash/store';

export type Surface = 'rest' | 'mcp';

export interface TrashAnswer {
  trash_id: number | null;
  // Present while kept: how many days, until when, and the call that restores it.
  kept_days?: number;
  restorable_until?: string;
  how_to_restore?: string;
  state?: 'kept' | 'moving';
  note?: string;
}

export function trashAnswer(
  userId: string, trashId: number | null, surface: Surface, column?: { moving: boolean },
): TrashAnswer {
  if (trashId === null) {
    return {
      trash_id: null, note: 'Deleted: Settings keeps deleted items 0 days, so nothing went to the trash.',
    };
  }
  const days = getTrashDays(userId);
  const at = db.prepare('SELECT deleted_at FROM trash_items WHERE id = ? AND user_id = ?').pluck()
    .get(trashId, userId) as string | undefined;
  return {
    trash_id: trashId,
    kept_days: days,
    restorable_until: at ? trashExpiry(at, days) : undefined,
    how_to_restore: surface === 'mcp'
      ? `restore_from_trash with trash_ids [${trashId}] puts it back (list_trash shows what is in the trash).`
      : `POST /api/v1/trash/${trashId}/restore puts it back (GET /api/v1/trash lists the trash).`,
    ...(column ? { state: column.moving ? 'moving' as const : 'kept' as const } : {}),
    ...(column?.moving ? { note: movingNote(trashId, surface) } : {}),
  };
}

const movingNote = (trashId: number, surface: Surface) => 'Its cells are still going to the trash, in the '
  + 'background: the column is gone from the sheet already. '
  + (surface === 'mcp' ? `list_trash with trash_id ${trashId}` : `GET /api/v1/trash/${trashId}`)
  + ' shows state "moving" until they are all in; a restore before then is refused, so try again in a moment.';
