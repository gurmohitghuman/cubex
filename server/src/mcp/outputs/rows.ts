// What the row tools answer (tools-rows.ts, tools-transfer.ts, tools-transform.ts, tools-dedupe.ts).
import { z } from 'zod';
import { obj } from '../output-schema';
import { autoDedupe, autoRunNotice, bool, cells, changed, info, nul, num, opt, str, strs, trash } from './shared';

const replayed = opt(bool).describe('true: an idempotency_key retry; nothing was written');

export const appendRows = obj({
  rows: z.array(obj({ id: str, index: num, kept: opt(bool).describe('false: auto-dedupe sent it to the trash') })),
  auto_dedupe: opt(autoDedupe), replayed, auto_run: opt(autoRunNotice), changed,
});

// One row: the row; many rows: updated.
export const updateCells = obj({
  id: opt(str), index: opt(num), data: opt(cells).describe('One-row form: the whole row'),
  updated: opt(num).describe('Many-rows form: rows updated'), auto_dedupe: opt(autoDedupe), replayed,
  data_left_out: opt(bool).describe('A replay of a big row: data is left out, read the row'), note: opt(str), changed,
});

export const deleteRows = obj({ deleted: num, trash: nul(trash), changed });

export const transferRows = obj({
  matched: num, copied: num, moved: num, created_columns: opt(strs), dest_row_count: opt(num), replayed: bool,
  trash_id: opt(nul(num)), trash: opt(trash), auto_dedupe: opt(autoDedupe), auto_run: opt(autoRunNotice), changed,
});

// A stopped or refused pass is an error result that carries error, next_cursor and rows_done.
export const transformColumn = obj({
  updated: opt(num), created_column: opt(nul(str)),
  next_cursor: opt(str).describe('Rows are left: call again with cursor set to it'), note: opt(str),
  error: opt(str), rows_done: opt(num).describe('With error: rows the pass wrote so far'), changed,
});

const keyColumn = obj({ column: str, match: str, phone_country: opt(str) });
export const removeDuplicates = obj({
  dry_run: bool, columns: z.array(keyColumn), keep: str, rows_checked: num, duplicate_groups: num,
  rows_with_empty_key: num, samples: z.array(info('A duplicate group: its key and rows')),
  largest_group: opt(info('The largest duplicate group')), rows_to_remove: opt(num), rows_removed: opt(num),
  rows_left: num, blocked_by_run: opt(str), note: opt(str), trash: opt(trash), changed,
});

export const setAutoDedupe = obj({ auto_dedupe: nul(info('The setting now, as get_sheet shows it')), changed });
