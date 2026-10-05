import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './db-path';

// CSV uploads land in <data dir>/uploads, owner-only, next to the database:
// never the working directory, which differs between `npm start`, the
// installer and Docker. Each import deletes its file when it's done; a restart
// in the middle of one would leave the file behind, so the folder is emptied
// at boot (an import cut short is undone anyway: lib/import-undo.ts).
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

// Call once at boot, before the server listens.
export function prepareUploadDir(): void {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(UPLOAD_DIR, 0o700); } catch { /* not ours to chmod */ }
  for (const entry of fs.readdirSync(UPLOAD_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    try { fs.unlinkSync(path.join(UPLOAD_DIR, entry.name)); }
    catch (err) { console.warn(`Could not remove leftover upload ${entry.name}:`, err); }
  }
}
