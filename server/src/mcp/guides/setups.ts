// The guides of the tools that run setups and several columns at once (guide.ts says what a guide holds).
import type { ToolGuide } from './guide';

export const SETUP_GUIDES: Record<string, ToolGuide> = {
  apply_setup: {
    text: [
      'A step whose columns this setup made before CARRIES THEM ON, filling only rows it hasn\'t done: call again '
        + 'with the same inputs and names to fill new rows or finish a stopped run (get_setup_run shows the choices '
        + 'a run used).',
      'Each started AI and enrichment step gets a spend limit within what is left of the ceiling (one with no known '
        + 'price runs without one).',
    ],
    spendCap: true,
  },
  run_columns: {
    text: [
      'A column reading another chosen column (also through formula, clean or lookup columns) waits for that one\'s '
        + 'whole run.',
    ],
    spendCap: true,
  },
  list_setup_versions: {
    text: [
      'A setup version is a named copy of how a sheet\'s columns are set up, never their values: every column in '
        + 'order with its description, what fills it (an AI column\'s prompt, model and settings; an HTTP API, '
        + 'enrichment or waterfall column\'s request or choices; a clean, formula or lookup column\'s settings), its '
        + '"Only run if" rule and auto-run.',
      'Without version_id: the sheet\'s versions, newest first (name, when, who saved it, how many columns and '
        + 'filled columns; auto true for a copy a restore kept of the setup it replaced). With version_id: that '
        + 'version against the sheet now, the same answer as restore_setup_version with dry_run: each column the '
        + 'version names that is gone (restoring adds it back, empty), set up differently (field by field, version '
        + 'vs now), filled another way now (restoring leaves it) or not in the version (it stays).',
      'Request URLs are masked, headers show by name and request bodies only as changed.',
    ],
  },
  restore_setup_version: {
    text: [
      'With dry_run false it first keeps the current setup as a version, then: gone columns come back EMPTY, with '
        + 'their setup; the others get the version\'s setup, descriptions and order; columns not in the version '
        + 'stay; a column (or an AI column\'s output column) filled another way now is left, with a note.',
      'AI, HTTP API, enrichment and waterfall columns run the restored way next time (control_run rerun mode all '
        + 'bills every row); clean, formula and lookup columns keep their cells until their own tool works them out '
        + 'again (free). Refused while a run or setup is going on the sheet, or a clean, formula or lookup column '
        + 'is still filling.',
    ],
  },
  save_setup: {
    text: [
      'Each step is saved as its column is set up now: prompt, model, web search, output columns, request, '
        + 'JSONPaths, enrichment choices, formula, cleaner, "Only run if" and auto-run. Saved keys are kept by name, '
        + 'never their value. A column that adds rows to another sheet can\'t be saved. preview: true returns what '
        + 'the setup would hold (its steps in order, inputs and keys) and saves nothing.',
    ],
  },
};
