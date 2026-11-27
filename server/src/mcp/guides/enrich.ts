// The guides of the enrichment, waterfall, stored answers and auto-run tools (guide.ts says what a guide holds).
import { RUN_IF_HELP } from '../run-if-schema';
import { saveOnlyHelp } from '../save-only-schema';
import type { ToolGuide } from './guide';
import { ENRICH_ITEMS_TEXT } from './items';

export const ENRICH_GUIDES: Record<string, ToolGuide> = {
  find_enrichments: {
    text: [
      'search: Search treg.to\'s catalog of enrichment tools (work email, phone, person or company data, people or '
        + 'companies lists, web search). No query: the popular jobs. Each tool has tool_id, kind (waterfall: treg asks '
        + 'many providers in turn; single: one provider), its price, and adds_rows (its results become rows in '
        + 'another sheet). needs_own_key: treg can\'t serve it on its own key, the team needs its own provider key at '
        + 'treg.',
      'get: One enrichment tool, ready for run_enrichment: its inputs (name, type, required; identity_sets lists the '
        + 'inputs that are enough together; filter inputs narrow a search), its outputs (field names for '
        + 'run_enrichment outputs; for a tool that adds rows, only the fields outside its results, which fill the '
        + 'asking row; the results\' own fields come from real results), its price, and for a waterfall each provider '
        + '(price, hit rate, the inputs it accepts, and with a treg key saved, access as treg\'s plan says: your_key '
        + '(the team\'s own key), your_connection_metered, free, treg (treg\'s key), or null when the plan doesn\'t '
        + 'say). The email finder also offers the verified_email preset.',
    ],
  },
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
      ...ENRICH_ITEMS_TEXT,
    ],
    fields: { run_if: RUN_IF_HELP, save_only: saveOnlyHelp('run_enrichment') },
    spendCap: true,
  },
  stored_answers: {
    text: [
      'add_column: Free: no treg calls and no requests. Find json_path in a stored answer: get_run (action results) '
        + 'with include_answers:true shows them (paths start at the answer\'s root, e.g. '
        + '$.output.company.linkedin_url or $.raw.location). Later runs of the column fill it too. It fills in the '
        + 'background: its cells read "⏳ Processing..." and the sheet refuses other changes until done. A part of '
        + 'an answer too big to keep, and columns that add rows to another sheet, are refused. Returns the column '
        + 'and whether it is still filling: get_sheet\'s filling_columns says when it is done.',
      'add_rows: Pick the fields to keep for a list job\'s results waiting for them (from get_list_fields), and add '
        + 'those results as rows in the destination sheet, one row per result: free, the results are already paid '
        + 'for. Each field becomes a column there (an existing column of that name is filled). dedupe_path (one of '
        + 'the fields) skips a result whose value matches a row added before. The column keeps these fields, so '
        + 'control_run rerun mode "empty" then runs the rest of the rows. Adding them costs nothing here, but '
        + 'auto-runs on the destination sheet fill new rows there: auto_run lists them, as for append_rows.',
      'Both need the write scope.',
    ],
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
