// Free space on the data folder (the databases and their WAL files), for
// /api/health and the stalled-run sweep. null when the OS can't say.
import fs from 'node:fs';
import { DATA_DIR } from './db-path';
import { DISK_LOW_BYTES } from './constants';

export function dataDirFreeBytes(): number | null {
  try {
    const s = fs.statfsSync(DATA_DIR);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

export const diskLow = (free = dataDirFreeBytes()): boolean => free !== null && free < DISK_LOW_BYTES;
