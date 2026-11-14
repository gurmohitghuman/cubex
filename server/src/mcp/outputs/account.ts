// What the model, version, trash, history and saved-key tools answer (tools-models.ts, tools-version.ts,
// tools-trash.ts, tools-saved-keys.ts).
import { z } from 'zod';
import { obj, open } from '../output-schema';
import { bool, changed, info, nul, num, opt, str, strs } from './shared';

export const listModels = obj({
  models: z.array(obj({ id: str, name: str, context_length: nul(num), pricing: info('Dollars per token') })),
  total_matching: num, account_default_model: nul(str),
});
export const setDefaultModel = obj({
  account_default_model: opt(nul(str)), sheet_id: opt(str), default_ai_model: opt(nul(str)),
  validated: opt(bool), warning: opt(str),
});

const change = obj({
  change: z.enum(['added', 'changed', 'removed', 'renamed', 'server']), tools: opt(strs),
  replaced_by: opt(str), summary: str, details: opt(str),
});
export const getVersion = obj({
  version: nul(str), build: nul(str), pinned_ref: nul(str), update_check: bool,
  latest_release: nul(obj({ version: str, published_at: nul(str), checked_at: str, notes_url: str })),
  update_available: nul(bool),
  changes_since: opt(obj({
    since: str, releases: z.array(obj({ version: str, changes: z.array(change) })), note: opt(str),
  })).describe('With since: what changed for agents in every release after it, oldest first'),
});

// An item: by kind, rows and cells, a column's name and kind.
const trashItem = open({
  id: num, kind: str, state: str, deleted_at: str, expires_at: str, table_id: nul(str), table_name: nul(str),
  sheet_id: nul(str), sheet_name: nul(str), how: str, by: str, via: str, token_name: nul(str),
});
// No trash_id: items. With one: that item and, for rows or a column, what it holds.
export const listTrash = obj({
  items: opt(z.array(trashItem)), kept_days: opt(num), next_before: opt(nul(num)), total_bytes: opt(num),
  item: opt(trashItem), trash_id: opt(num), columns: opt(strs),
  rows: opt(z.array(obj({ seq: num, row_id: str, old_row_index: num, cells: info('Column -> value') }))),
  next_after: opt(nul(num)),
});
// trash_ids: results, one per item. trash_id with seqs: the rows restored.
export const restoreFromTrash = open({
  results: opt(z.array(open({
    trash_id: num, restored: opt(info('What came back and where')), error: opt(str), fail: opt(str),
  }))),
  trash_id: opt(num), sheet_id: opt(str), state: opt(str), rows: opt(num), place: opt(str),
  columns_added: opt(strs), columns_left_out: opt(strs), changed,
});

export const getSheetHistory = obj({
  changes: z.array(obj({
    id: num, at: str, via: str, token_name: nul(str), by: str, action: str, column: nul(str), summary: str,
    detail: nul(info('What changed, by action')), in_trash: opt(bool),
  })),
  next_before: nul(num), kept_days: num,
});

export const listSavedKeys = obj({
  keys: z.array(obj({
    name: str, created_at: str, updated_at: str, used_in: z.array(info('A column that uses the key')),
    used_in_count: num, setups: z.array(obj({ setup_id: str, name: str })), setups_count: num,
  })),
  keys_count: num, next_after: opt(str),
});
