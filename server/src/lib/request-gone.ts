import type { Response } from 'express';

// Stops a long walk (a search, counts) once the asker has gone: true after the
// request closed before its answer was written.
export function watchGone(res: Response): () => boolean {
  let gone = false;
  res.on('close', () => { if (!res.writableFinished) gone = true; });
  return () => gone;
}
