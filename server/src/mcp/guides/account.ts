// The guides of the trash, version and account tools (guide.ts says what a guide holds).
import { OPENROUTER_BALANCE_CACHE_MS } from '../../lib/constants';
import { SAVED_KEY_USES_BRIEF, SAVED_KEY_USES_LISTED, SAVED_KEYS_LISTED } from '../../lib/api-v1-constants';
import type { ToolGuide } from './guide';

export const ACCOUNT_GUIDES: Record<string, ToolGuide> = {
  restore_from_trash: {
    text: [
      'A sheet or table comes back whole (rows, columns, runs, views, webhook), renamed "<name> (restored)" if the '
        + 'name was taken. Rows go back to their old places when the sheet was not sorted, replaced or deduplicated '
        + 'since and those are free, else to the end in order; columns they need are added again (columns_added); a '
        + 'sheet without room refuses. Rows moved out with transfer_rows stay in their new sheet too. Auto-run does '
        + 'not run restored rows.',
      'A column comes back at its old place with its setup and auto-run off (renamed if its name was taken); its '
        + 'cells go only on rows that still exist and are empty there (cells_kept: rows holding a value now; '
        + 'cells_skipped: rows gone; both stay in the item). Rerun an AI or HTTP API column with control_run and '
        + 'setup.run_id; a clean, formula or lookup column works its rows out again.',
      'references_dropped lists what did not come back, each with redo (the tool to set it up again). A refused '
        + 'item is in results with its error; the others still go. A big batch answers state "restoring" and '
        + 'finishes in the background.',
    ],
  },
  list_trash: {
    text: [
      'Without trash_id: the list, newest first (how auto_dedupe with a sheet_id lists what auto-dedupe removed '
        + 'there, one batch a day). With trash_id: that item, and for a batch or a column its rows (cells as they '
        + 'were, seq, row_id, old_row_index) a page at a time, or only rows holding a text (a search reads part of a '
        + 'big batch per call; next_after goes on). A column in state "moving" is still getting its cells: restore '
        + 'it once it reads "kept".',
    ],
  },
  get_balances: {
    text: [
      'What the account can spend, read live: treg {balance_usd, on_hold_usd} for enrichments, '
        + 'enrichment_daily_limit {limit_usd, used_today_usd, remaining_usd}, and openrouter for AI runs '
        + '{balance_usd (account credits, often null: OpenRouter shares it only with a management key), '
        + 'key_limit_usd, key_limit_remaining_usd, key_usage_usd, byok_usage_usd, available_usd, checked_at (when '
        + `Cubex read them; a read is reused for ${OPENROUTER_BALANCE_CACHE_MS / 1000} seconds)}: OpenRouter's `
        + 'numbers can lag behind runs that just finished, while access_token.spent_usd is live. A part that is not '
        + 'set up or can\'t be reached says so in error.',
      'OpenRouter holds each running AI call\'s possible cost, so a high concurrency needs more free credit than the '
        + 'run will spend: run_ai_column\'s estimate_only reports that as in_flight. access_token {spend_cap_usd, '
        + 'spent_usd, left_usd} is this token\'s own spend cap on AI and enrichments (null: no cap), for its whole '
        + 'life, not per month.',
    ],
  },
  get_version: {
    text: [
      'Which Cubex version this server runs and whether a newer release is out: version (the running release, like '
        + '"v0.8.12"; null for a build from a branch or a local source, or one that doesn\'t record its version, such '
        + 'as Docker), build (the build as the installer recorded it, null when not recorded), pinned_ref (an install '
        + 'made with --ref stays on that ref: `cubex update` reinstalls it, and getting newer releases needs the '
        + 'install command run again without --ref; null otherwise), update_check (the daily release check is on; '
        + 'the user turns it off in Settings), latest_release {version, published_at, notes_url, checked_at} (null '
        + 'when the check is off or has no answer yet) and update_available (null when it can\'t be told).',
      'Reads what the check kept: it never asks GitHub itself. On a newer release, an install made with the '
        + 'installer and not pinned updates with `cubex update`; others follow the release notes.',
      'With since (the version you last used), it adds changes_since {since, releases: [{version, changes: '
        + '[{change: added, changed, removed, renamed or server, tools, replaced_by, summary, details}]}], note}: '
        + 'what changed for agents in every release after it, oldest first.',
    ],
  },
  get_usage: {
    text: [
      'Each row and the totals give runs, cells (rows run), reused_cells (filled at $0 from an earlier answer), '
        + 'ai_cost_usd (OpenRouter), provider_cost_usd (the user\'s own provider key), enrichment_cost_usd (treg), '
        + 'total_cost_usd and cost_per_cell_usd. Days are UTC and a run counts on the day it started. AI previews '
        + 'and AI helpers (write_formula, write_run_condition) count too, as kind preview or assist. Totals cover '
        + 'the whole range; rows_total says how many rows there are (GET /api/v1/usage with format=csv has every '
        + 'row). Deleted columns and sheets are included (column_deleted, sheet_deleted).',
    ],
  },
  list_saved_keys: {
    text: [
      'The saved API keys (Settings > External service keys) by name, never their values: for each, created_at and '
        + 'updated_at (UTC), and where it is used: used_in lists each HTTP API, enrichment or waterfall column whose '
        + 'request names the key (sheet_id, sheet_name, table_id, table_name, column, kind, and auto_run when the '
        + 'column fills new rows on its own), and setups the saved setups that name it.',
      `At most ${SAVED_KEYS_LISTED} keys a call, by name, with ${SAVED_KEY_USES_BRIEF} places and setups each; `
        + 'keys_count, used_in_count and setups_count are whole. For more keys, pass next_after as after; for more '
        + `of one key's places, pass its name (up to ${SAVED_KEY_USES_LISTED} of each). Sheets in the trash and `
        + 'setup versions are left out.',
    ],
  },
};
