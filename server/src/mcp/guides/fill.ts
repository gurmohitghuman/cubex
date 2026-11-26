// The guides of the free tools that fill or clean columns and remove duplicates (guide.ts says what a guide holds).
import type { ToolGuide } from './guide';

export const FILL_GUIDES: Record<string, ToolGuide> = {
  clean_column: {
    text: [
      'The name and company cleaners drop emoji, read full-width characters as plain ones, and leave a placeholder '
        + 'cell (n/a, none, null, unknown, test, -) blank.',
    ],
    fields: {
      cleaner: 'person_name (fixes ALL CAPS or lowercase, keeping DeShawn and McDonald; turns "Smith, John" around; '
        + 'drops Mr/Dr/Jr/PhD and nicknames), first_name ("J. Michael Fox" gives "Michael"; never the last name), '
        + 'last_name (keeps "van", "de la"), company_name (drops Inc, LLC, GmbH and other legal endings, ", a '
        + 'company of X" and stray brackets; fixes ALL CAPS), email (lowercase; blank when the format is invalid, '
        + 'which says nothing about delivery), domain (the root domain of a website or email: '
        + '"https://blog.acme.co.uk/x" gives "acme.co.uk"), phone (blank when not a real number), title_case (keeps '
        + 'small words and acronyms: "VP of Sales"), lowercase, trim (also inner spaces, line breaks and invisible '
        + 'characters), fix_encoding (repairs UTF-8 read as Windows-1252 or Latin-1: "CafÃ©" gives "Café"; what it '
        + 'can\'t repair stays as it was)',
    },
  },
  formula_column: {
    text: [
      'A cell holding JSON (text starting with { or [, like a whole HTTP response written by run_http_enrichment '
        + 'mapping "$") arrives parsed, so find/filter/map work on it; this is how to pick an item by a condition, '
        + 'which JSONPath mappings refuse. Status cells ("⏳ Processing...", "❌ ...", "⏭️ ...") read as empty.',
      '_ is Lodash. There is no network or file access. The result is written as text (objects and lists as JSON; '
        + 'null, undefined and NaN as an empty cell). A row the formula cannot work out shows "❌ <the error>" and '
        + 'counts in error_rows (first_error names the first).',
    ],
  },
  lookup_column: {
    text: [
      'Matching ignores case (accents too) and surrounding spaces; status cells (⏳, ❌, ⏭️) read as empty on both '
        + 'sides. A row it cannot answer honestly shows "❌ <why>" (a contains value under 3 characters, over '
        + '10,000 contains matches) and counts in error_rows.',
      'Renaming columns there updates the lookup; deleting that sheet or a column it reads stops it (broken says '
        + 'why).',
      'Refused while a run fills match_column or a column it returns. While a run or fill writes a column it '
        + 'reads, or that sheet is sorted, replaced or deduplicated, the fill waits ("waiting") and then looks every '
        + 'row up again, at most 3 times (then kept_changing names what kept changing: rows looked up before may '
        + 'hold older values; call again to redo them). Lookups that would wait for each other in a loop fail, '
        + 'naming each column.',
    ],
  },
  transform_column: {
    text: [
      'Example: turn "8 | B2B SaaS" into a number with regex_extract pattern "^(\\\\d+)".',
      'An error after some rows carries next_cursor and rows_done: go on with that cursor, never start over (those '
        + 'rows would get the operation twice). While a pass is unfinished, a call on the same column without its '
        + 'cursor is refused with the cursor; restart:true starts over instead. If the pass\'s rows move (a sort, '
        + 'an import undone, duplicates removed, rows restored to other places), every call into its column is '
        + 'refused until restart: true, unless it had done no rows. A pass ends at the last row, on restart or when '
        + 'its column is permanently deleted.',
    ],
  },
  remove_duplicates: {
    text: [
      'Each column can match as: text (default), email, domain ("https://www.acme.com/x", "jo@acme.com" and '
        + '"acme.com" all match; a free email address such as Gmail never matches by domain, and a page on a shared '
        + 'site such as facebook.com/acme matches only the same page), phone (any format, an extension kept apart; '
        + 'phone_country, default US, says how bare digits are read), company (ignores Inc, LLC, Corp and other '
        + 'legal endings) or person_name ("Smith, John" matches "John Smith"; Jr and Sr kept apart).',
      'A row with any listed column empty, unreadable as its match, or holding a run status such as "⏭️ Not found" '
        + 'is never removed.',
      'Their AI and HTTP results go.',
    ],
  },
  set_auto_dedupe: {
    text: [
      'Blank keys, run statuses and cells over 200 characters never match.',
      'The key column must be one rows arrive with, not an AI, HTTP, enrichment, waterfall, clean, formula or lookup '
        + 'column; to match a cleaned value, pick the raw column with a match (a website column as domain). The '
        + 'answers of the tools that add or edit rows say which were not kept or were replaced. Call again to '
        + 'change it (fields left out stay).',
    ],
  },
  write_formula: {
    text: [
      'The model sees the column names and what the first rows hold (the shape of JSON cells), and the formula is '
        + 'checked on the first rows before it is returned. Returns the formula, the model used, what the call cost, '
        + 'and a preview (samples with their inputs and results).',
    ],
  },
};
