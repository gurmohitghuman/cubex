// The guides of the enrichment, waterfall and auto-run tools (guide.ts says what a guide holds).
import { RUN_IF_HELP } from '../run-if-schema';
import { saveOnlyHelp } from '../save-only-schema';
import type { ToolGuide } from './guide';

export const ENRICH_GUIDES: Record<string, ToolGuide> = {
  waterfall_column: {
    text: [
      'A value result_type can\'t read is no answer, and the next step runs. A row with none of a step\'s requires '
        + 'key sets skips it for free. column_name holds the answer, "⏭️ Not found" or "❌ <step>: <why>"; '
        + '"<column> (Answered by)" names the step.',
      'A treg answer found within the days set in Settings is reused at $0.',
      'action "describe" (read scope) returns a column\'s setup in this shape to edit and send back (without the '
        + 'secrets scope HTTP keys read "…" and are kept when sent back with the same id and URL).',
    ],
    fields: { run_if: RUN_IF_HELP, save_only: saveOnlyHelp('waterfall_column') },
    spendCap: true,
  },
  run_enrichment: {
    text: [
      'A row whose exact lookup found something within the days set in Settings reuses it at $0.',
      'A row whose providers all answer 429 asks again for free (rate_limit_retries), then fails; lower concurrency '
        + 'if 429s go on.',
    ],
    fields: { run_if: RUN_IF_HELP, save_only: saveOnlyHelp('run_enrichment') },
    spendCap: true,
  },
  set_auto_run: {
    text: [
      'Clean and formula columns follow their source columns instead, free and without run_if or caps (turning a '
        + 'formula column on again lifts a pause). A resume takes waiting_rows for the rows that waited meanwhile.',
      'An enrichment\'s daily_cap_usd is never above the daily limit.',
    ],
    spendCap: true,
  },
  ai_visibility: {
    text: [
      'action "create" (free, asks nothing) makes a table "AI visibility for <brand>": a Questions sheet (per '
        + 'engine a column asking it, its answer, and "You in <engine>": "1st of 4" = your place among the brands '
        + 'named, or "Not named"; "Named by": how many engines name you; "Named first": the brand most engines name '
        + 'first) and a Cited sites sheet (every source an answer cites, with "Your site"). Brands are matched as '
        + 'whole words, ignoring case and accents, among brand and other_brands only.',
      'action "check_again" (weeks later) copies Questions and Cited sites, values only, into sheets named with the '
        + 'day they were asked, adds "Named by on <date>" and "Change since <date>" ("Up 2", "Down 1", "Same", '
        + '"New"), then asks every question again: also PAID, and it notes answers under three weeks old (a change '
        + 'then is mostly the usual variation). A stopped check is picked up by the next one.',
      'Read the table with read_rows (group_by Named first, or Domain on Cited sites, for counts). Answers vary '
        + 'between asks: compare totals, not one question.',
    ],
  },
};
