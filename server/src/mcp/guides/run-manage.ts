// The guides of the tools that follow, control and undo runs: get_run (its status, results, list and setup),
// control_run and undo_run (guide.ts says what a guide holds).
import { STATUS_WORDS } from '../../services/enrich-agent-shared';
import { ANSWERS_PAGE_MAX } from '../../lib/api-v1-constants';
import { MAX_RUN_WAITS_PER_USER } from '../../lib/long-poll-holds';
import { GET_SETUP_RUN_GUIDE } from './items';
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
  get_run: {
    text: [
      'status: One run\'s state: status (pending, running, paused, completed, failed, cancelled), row counts, '
        + 'error_message and cost_usd so far. Poll it with wait_seconds: it answers when the status changes or the '
        + `time is up (with ${MAX_RUN_WAITS_PER_USER} waits of your account open, at once with waited: false). `
        + '"completed" means every row was processed, not that it worked: check failed_rows, then get_run (action '
        + 'results). get_run (action list) finds a lost run_id. control_run resumes or cancels.',
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
      'results: Each row\'s outcome in a run: row id, status, error message and an error_class saying what to DO. '
        + 'Use it when cells are blank or wrong, instead of rerunning blind. include_answers adds each row\'s stored '
        + `answer (up to ${ANSWERS_PAGE_MAX} rows a page), to find paths for add_enrichment_field; on an HTTP run that `
        + 'used saved keys it needs the \'secrets\' scope. Pages by cursor.',
      'AI classes: "retryable" (a rerun works), "prompt_content" (your wording: a rerun just bills again), '
        + '"model_output" (try another model), "concurrency" (rerun with a lower concurrency), "configuration" (fix '
        + 'a setting), "unknown". HTTP classes: "retryable" (rate limit, timeout, 5xx), "not_found" (404 or 410; on '
        + 'every row, a wrong URL path), "configuration" (URL, auth, headers, {{name}}, JSONPath, blocked address), '
        + '"response_format" (not JSON), "unknown". Retry only the transient ones with control_run rerun (mode errored '
        + 'for AI, missing for HTTP).',
      'Rows add cost_usd (an AI row on your own provider key: only OpenRouter\'s fee, and provider_cost_usd); AI '
        + 'rows paid_with, tokens and searches; enrichment rows found_by; waterfall rows answered_by and trace (each '
        + 'step reached: outcome, value, cost).',
      'list: Recent runs, newest first: use it to FIND a run_id you no longer have (after a failed start, a '
        + 'disconnect, or a run someone else started). Enrichment runs show as type http with an enrichment block and '
        + 'cost_usd. A run whose rows wait for a column another run holds carries waiting.',
      'setup: Where a setup being used on a sheet (or a run_columns run, or a call on items) is: running, paused, '
        + 'done, failed or cancelled, the layer it\'s on, and each step\'s state, run_id and note (why it failed, or '
        + 'that its auto-run wasn\'t turned on), and the choices it was used with. Pass setup_run_id, or sheet_id for '
        + 'the sheet\'s latest ones (with setup_id, that setup\'s). Next: control_setup_run, or apply_setup again to '
        + 'carry it on.',
      ...GET_SETUP_RUN_GUIDE.text,
    ],
  },
  undo_run: {
    text: [
      'Clean, formula and lookup columns reading a restored cell work it out again (free); no auto-run starts. Rows '
        + 'a list enrichment added to another sheet stay (delete_rows removes them).',
      'Newest first: while a newer run that wrote one of its columns can be undone, an older one is refused.',
      'Returns state and how many cells were restored, skipped and gone; a big undo answers state undoing and goes '
        + 'on in the background (the sheet is busy meanwhile: call again with dry_run true to see how far it got).',
    ],
  },
};
