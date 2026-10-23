// A write that failed because the database can't be written at all (the disk
// is full, the file went read-only, an I/O error), as opposed to a busy lock
// or a bad statement. A run that meets one stops sending calls: each call is
// paid before its result is written, and none of them could be saved.
const STORAGE_CODES = /^SQLITE_(FULL|IOERR|READONLY|CANTOPEN|CORRUPT|NOTADB)/;

export function isStorageFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && STORAGE_CODES.test(code)) return true;
  const message = error instanceof Error ? error.message : '';
  return /database or disk is full|disk I\/O error|attempt to write a readonly database/i.test(message);
}
