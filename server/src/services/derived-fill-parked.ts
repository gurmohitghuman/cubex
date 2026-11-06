// Derived fills (derived-fill.ts) whose sheet is in the trash: it went there
// while a lookup's fill waited with the sheet free, or before a restart. They
// write nothing and nothing polls them: restoring the sheet or its table starts
// them again (trash-restore-sheet.ts), and the trash deleting the sheet deletes
// their records with it.
export const IN_TRASH_NOTE = 'Waits for its sheet to come back from the trash.';

interface Parked { sheetId: string; filling: () => boolean; resume: () => void }
const parked = new Map<string, Parked>();

export function parkFill(id: string, fill: Parked): void {
  // Those the trash has deleted since go (their records went with their sheet).
  for (const [other, p] of parked) if (!p.filling()) parked.delete(other);
  parked.set(id, fill);
}

export const isParked = (id: string): boolean => parked.has(id);

// The fills parked on these sheets go on, once they are restored: after the
// request that restored them, so a batch of its rows restored next in it
// (trash-actions.ts) isn't refused as busy, and a lookup the restore started
// takes its sheet first. Each then takes its sheet once it is free.
export function resumeFillsBackFromTrash(sheetIds: string[]): void {
  for (const [id, p] of parked) {
    if (!sheetIds.includes(p.sheetId)) continue;
    parked.delete(id);
    setImmediate(() => p.resume());
  }
}
