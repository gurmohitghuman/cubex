// The guides of the tools that follow, control and undo runs (guide.ts says what a guide holds).
import { STATUS_WORDS } from '../../services/enrich-agent-shared';
import type { ToolGuide } from './guide';

export const RUN_MANAGE_GUIDES: Record<string, ToolGuide> = {
  control_run: {
    text: [
      'An output_columns AI run reruns whole. An enrichment rerun buys rows from treg again (answers it still holds '
        + 'cost less or nothing).',
      'Lower concurrency after error_class "concurrency" or a provider\'s 429. A resumed run\'s spend counts toward '
        + 'this token\'s spend cap.',
      'CANCEL_ALL with sheet_id stops every active run and setup run on the sheet but turns no auto-run off: a '
        + 'column whose auto-run batch it stopped pauses (auto_run_paused), and auto_run_on lists columns where new '
        + 'rows still start runs (set_auto_run paused true with no column pauses them all).',
    ],
    spendCap: true,
  },
  get_run_status: {
    text: [
      'pause_reason says why a run paused itself, and pause_message what to do: token_cap, spend_limit (resume '
        + 'with a higher spend_limit_usd; an AI run\'s least is resume_least_usd), provider_errors, storage (free '
        + 'disk space first), stalled, web_engine (allow Exa on OpenRouter\'s Server Tools page); an enrichment\'s '
        + 'is in enrichment (daily_limit, balance, no_key, unreachable and others).',
      'waiting: its rows wait for a column another run (held_by) holds; a paused holder keeps them waiting.',
      'AI runs add concurrency, rows_paid_with, searches, web_search and spend_limit_usd; enrichment runs '
        + 'daily_limit, enrichment, providers and list; waterfall runs waterfall. On your own provider key cost_usd '
        + 'is only OpenRouter\'s fee; provider_cost_usd is the provider\'s bill. condition_skipped_rows (run_if) are '
        + 'not in total_rows.',
      STATUS_WORDS,
    ],
  },
  get_run_results: {
    text: [
      'AI classes: "retryable" (a rerun works), "prompt_content" (your wording: a rerun just bills again), '
        + '"model_output" (try another model), "concurrency" (rerun with a lower concurrency), "configuration" (fix '
        + 'a setting), "unknown". HTTP classes: "retryable" (rate limit, timeout, 5xx), "not_found" (404 or 410; on '
        + 'every row, a wrong URL path), "configuration" (URL, auth, headers, {{name}}, JSONPath, blocked address), '
        + '"response_format" (not JSON), "unknown". Retry only the transient ones with control_run rerun (mode errored '
        + 'for AI, missing for HTTP).',
      'Rows add cost_usd (an AI row on your own provider key: only OpenRouter\'s fee, and provider_cost_usd); AI '
        + 'rows paid_with, tokens and searches; enrichment rows found_by; waterfall rows answered_by and trace (each '
        + 'step reached: outcome, value, cost).',
    ],
  },
  undo_run: {
    text: [
      'Clean, formula and lookup columns reading a restored cell work it out again (free); no auto-run starts. Rows '
        + 'a list enrichment added to another sheet stay (change_rows delete removes them).',
      'Newest first: while a newer run that wrote one of its columns can be undone, an older one is refused.',
      'Returns state and how many cells were restored, skipped and gone; a big undo answers state undoing and goes '
        + 'on in the background (the sheet is busy meanwhile: call again with dry_run true to see how far it got).',
    ],
  },
};
