// Over 200 lines: one entry per release with changes for agents, newest first; shipped ones stay as they were.
// What changed for agents, release by release: tools added, changed, removed or renamed, and changes to the
// server's answers. Agents read it three ways (services/version-changes.ts): the server instructions name
// the running release and what changed in it, get_version with since lists every release after a version,
// and a call to a removed or renamed tool says what replaced it.
//
// A change to a tool's name or input schema needs a line here, under the release it will ship in (the next
// one after the latest tag, or the next patch after it once its tool list is recorded, just before its cut;
// rename it if that release gets another number). tests/unit/mcp-tool-list.test.ts
// compares the tools with the list recorded for the last release with lines (tests/unit/mcp-tool-list.json)
// and fails on a change without a line. A change agents should know about that the schema doesn't show (a
// new field in an answer, a new refusal) gets a line too. Write each line for an agent: what it calls now,
// and what it does differently. A release's lines stay as it shipped them: the test (where the tags are)
// and scripts/release.sh cut refuse an edit to them. v0.8.13 shipped before this file: its lines are
// history, checked against its tools when its list was recorded.

export type ChangeKind = 'added' | 'changed' | 'removed' | 'renamed' | 'server';

export interface AgentChange {
  change: ChangeKind;
  // The tools it is about. renamed: the one old name. server: none (serverInfo, the instructions).
  tools?: string[];
  // renamed (required) and removed (when something takes its place): the tool to call instead.
  replaced_by?: string;
  // One short line: the server instructions show it for the running release.
  summary: string;
  // What an agent does about it, when the summary doesn't say. get_version's since shows it.
  details?: string;
}

export interface ReleaseChanges {
  version: string;
  changes: AgentChange[];
}

// The first list recorded: changes are listed for the releases after this one.
export const CHANGES_RECORDED_AFTER = 'v0.8.12';

// Newest first.
export const AGENT_CHANGES: ReleaseChanges[] = [
  {
    version: 'v0.8.47',
    changes: [
      {
        change: 'changed',
        tools: ['manage_table'],
        summary: 'manage_table takes action star or unstar with table_id: a starred table is in the user\'s '
          + 'Favorites on the home.',
        details: 'Starring changes nothing in the table, so changed is []. The answer has the table\'s id, name and '
          + 'starred. PATCH /api/v1/tables/{id} takes starred too.',
      },
      {
        change: 'changed',
        tools: ['list_tables'],
        summary: 'list_tables gives each table starred (in the user\'s Favorites) and last_opened_at (when the user '
          + 'last opened it in the app, null until then).',
        details: 'Use them to find the tables the user works in. GET /api/v1/tables answers the same.',
      },
    ],
  },
  {
    version: 'v0.8.45',
    changes: [
      {
        change: 'added',
        tools: ['get_tool_guide'],
        summary: 'get_tool_guide gives a tool\'s full details. The longest tool descriptions are shorter now and end '
          + 'with "Details: get_tool_guide.": their edge cases, examples and long field notes moved there.',
        details: 'Read a tool\'s guide before its first paid or destructive call, and after a refusal. Without tool '
          + 'it lists the tools that have one. No tool or argument changed.',
      },
      {
        change: 'added',
        tools: ['call_setup', 'get_setup_call'],
        summary: 'call_setup runs a saved setup on 1-100 items without a sheet, like a function; get_setup_call '
          + 'answers each item\'s outputs once it finishes.',
        details: 'Items are objects keyed by the setup\'s inputs; estimate_only defaults to true. The call id is a '
          + 'setup run id: control_setup_run pauses or cancels it, a run webhook reports it as kind setup. Results '
          + 'are kept 24 hours.',
      },
      {
        change: 'added',
        tools: ['call_enrichment'],
        summary: 'call_enrichment runs one enrichment tool on 1-1,000 items without a sheet, refused up front instead '
          + 'of pausing halfway when it could pass max_cost_usd, the daily limit, the treg balance or the token cap.',
        details: 'It answers a run_id: get_run_status and get_run_results answer for it, with row_index as the '
          + 'item. estimate_only defaults to true.',
      },
      {
        change: 'changed',
        tools: ['create_upload_link', 'create_download_link'],
        summary: 'create_upload_link takes setup_id (with max_cost_usd) instead of sheet_id: the file\'s rows become a '
          + 'setup call\'s items, and the call starts once the file is in.',
        details: 'get_setup_call pages results with results_from and limit (next_from says where the next page '
          + 'starts); create_download_link takes setup_call_id to save every item\'s inputs and outputs as a CSV.',
      },
      {
        change: 'changed',
        tools: ['manage_sheet', 'get_sheet'],
        summary: 'manage_sheet tries column changes on sample rows: test copies a sheet\'s top rows and setup into a '
          + 'hidden copy, apply_test makes the copy\'s setup the sheet\'s and puts the sample results back, '
          + 'discard_test drops it.',
        details: 'Work in test.test_sheet_id with the usual tools; meanwhile the sheet answers busy to every change '
          + 'and its webhook deliveries wait (get_sheet\'s test). apply_test is a dry run unless dry_run is false.',
      },
      {
        change: 'changed',
        tools: ['get_usage'],
        summary: 'get_usage counts runs on a sheet\'s test copy under that sheet, also after the test ends: their '
          + 'rows have on_test_copy: true, apart from the sheet\'s own column of the same name.',
        details: 'The whole account\'s usage lists them under the tested sheet too, not as a deleted sheet. REST: GET '
          + '/usage, whose CSV has an On sample rows column.',
      },
      {
        change: 'changed',
        tools: ['get_usage'],
        summary: 'get_usage lists what a call without a sheet ran as call: true, with sheet_id and sheet_name null, '
          + 'not as a deleted sheet; by column every call adds up in one row.',
      },
      {
        change: 'changed',
        tools: ['manage_sheet_webhook'],
        summary: 'manage_sheet_webhook takes set_auto_delete and auto_delete_off: a webhook sheet keeps its newest '
          + 'keep_rows rows and deletes older ones once they are finished, not to the trash.',
        details: 'A row leaves once every auto-run column has run on it and, with success_column, once that has a '
          + 'result; copy_to_sheet_id copies it to another sheet first. get\'s webhook has auto_delete, null while '
          + 'off.',
      },
      {
        change: 'changed',
        tools: ['manage_sheet_webhook'],
        summary: 'manage_sheet_webhook\'s set_auto_delete takes mode "rules" with where (read_rows\' language): older '
          + 'webhook rows are deleted once they pass it, whether auto-run has run on them or not.',
        details: 'get\'s auto_delete has mode and where. A switch to rules needs success_column: null when one is '
          + 'set; a switch back to actions_finish clears the rules.',
      },
    ],
  },
  {
    version: 'v0.8.44',
    changes: [
      {
        change: 'changed',
        tools: ['run_enrichment', 'waterfall_column'],
        summary: 'run_enrichment and waterfall_column take rate_limit_retries (0-10, default 5): how many times a '
          + 'step retries for free when providers answer 429.',
        details: 'Each waterfall step and check counts its own, and a verified email\'s finds and checks share one. '
          + 'Reruns, auto-run and waterfall_column describe keep it. Set 0 to fail fast on a 429, or up to 10 to '
          + 'wait longer for tight provider limits.',
      },
      {
        change: 'changed',
        tools: ['list_tables'],
        summary: 'list_tables no longer counts every row on the call: a sheet whose rows changed is counted first, '
          + 'waiting up to 2 seconds. One still being counted then answers its last count with '
          + 'row_count_updating: true.',
        details: 'row_count_updating means that row_count may be out of date: call list_tables again in a moment for '
          + 'the new count. GET /api/v1/tables answers the same.',
      },
      {
        change: 'changed',
        tools: ['create_download_link'],
        summary: 'create_download_link takes format: csv (default) or jsonl, one {"id", "data"} object a line as '
          + 'read_rows answers a row, values keeping their type.',
        details: 'Use jsonl to feed a script or another tool; CSV stays the one to open in a spreadsheet. REST: GET '
          + '/sheets/:id/export?format=jsonl.',
      },
      {
        change: 'changed',
        tools: ['run_ai_column', 'run_http_enrichment', 'run_enrichment', 'waterfall_column'],
        summary: 'save_only: true stores a column\'s new setup and runs nothing (no rows, no cost). It answers '
          + 'saved: true and run_id, the setup\'s record: control_run rerun with it runs the column so.',
        details: 'A new column is made empty. An existing HTTP API column takes a new setup only this way. Refused '
          + 'with estimate_only, output_columns, a list job, or what only a run takes (target_row_ids, preview_rows).',
      },
      {
        change: 'added',
        tools: ['social_research'],
        summary: 'social_research makes a table of social posts on a topic (TikTok, Instagram, YouTube, X), with '
          + 'transcripts, an AI breakdown, creators, their usual views and comments set up and not run; find_posts '
          + 'searches (paid).',
        details: 'create is free. find_posts is an estimate unless estimate_only is false, then needs the estimate\'s '
          + 'high_usd as max_cost_usd; running it again adds only new posts. Run the steps on the Top posts view\'s '
          + 'rows with each column\'s own run.',
      },
      {
        change: 'changed',
        tools: ['export_csv'],
        summary: 'export_csv puts its leading quote on a cell whose first visible character is a formula trigger: '
          + 'after spaces or invisible characters, and for full-width forms like ＝, not only at the start.',
        details: 'Spreadsheet apps hide the quote and show the text; import_csv takes it off again. A plain number '
          + 'after spaces, like " -5", is left as it is.',
      },
      {
        change: 'changed',
        tools: ['read_rows', 'control_run'],
        summary: 'Out of date now checks each row against the columns its own run read: a new setup that reads other '
          + 'columns no longer marks the rows made before it out of date.',
        details: 'read_rows where out_of_date, include_status and control_run\'s out_of_date modes agree. A row made '
          + '16 or more such setups ago never reads out of date.',
      },
      {
        change: 'added',
        tools: ['list_prompt_starters'],
        summary: 'list_prompt_starters gives good first prompts for an AI column on a sheet, the ones the app offers, '
          + 'each as run_ai_column\'s arguments.',
        details: 'Qualify, classify, an opener, a lead score and a company profile, written with the sheet\'s own '
          + 'columns. Fill in the [square brackets] before running one. REST: GET /sheets/:id/prompt-starters.',
      },
      {
        change: 'changed',
        tools: ['transfer_rows'],
        summary: 'A transfer_rows retry with its idempotency_key answers its first transfer even while either sheet '
          + 'is busy, and doesn\'t count toward the 10 transfers a minute.',
        details: 'A new key, or the same key with other arguments, is still refused as busy while a sheet is.',
      },
      {
        change: 'server',
        summary: 'read_rows with include_status gives a condition_not_met cell a why: each part of the column\'s "Only '
          + 'run if" the row fails now, with what the cell holds. Free, no AI.',
        details: 'check_run_condition\'s sample rows that fail carry the same why. A row that passes the rule now '
          + '(its cells changed since) says so: rerun it to fill it.',
      },
      {
        change: 'changed',
        tools: ['hiring_signals'],
        summary: 'hiring_signals takes action "update" (write scope, free): change min_roles, leave_out_companies or '
          + 'both after create. They apply from the next check.',
        details: 'A company kept off before gets its row at the next check if it passes now; a row already on '
          + 'Companies stays. null resets one (every company, none left out). PATCH /api/v1/hiring/{id} does the same.',
      },
      {
        change: 'added',
        tools: ['manage_sheet_webhook'],
        summary: 'manage_sheet_webhook sets up a sheet\'s incoming webhook, where each JSON event POSTed becomes a '
          + 'row: get, create, turn_on, turn_off, rotate, add_field, remove_field, new_token, remove_token and '
          + 'delete.',
        details: 'get needs read, the rest write. The url shows only to a write key, until the first event; then '
          + 'rotate makes a new one. new_token answers a token, shown once, that senders must send as '
          + 'Authorization: Bearer <token>.',
      },
      {
        change: 'changed',
        tools: ['set_auto_run'],
        summary: 'set_auto_run takes waiting_rows on a resume (paused false): run (default, as before), empty_only '
          + 'or skip, for the rows added or changed while auto-run was paused.',
        details: 'empty_only drops the waiting rows whose cell already holds a value ("keep existing results"); skip '
          + 'drops every waiting row, so only rows added or changed from now on run. PUT '
          + '/api/v1/sheets/{id}/enrichment-auto-run takes the same.',
      },
      {
        change: 'changed',
        tools: ['manage_table', 'manage_sheet'],
        summary: 'manage_table and manage_sheet create take webhook: true to give the new sheet an incoming webhook '
          + 'in the same call. The answer\'s webhook has its url.',
      },
      {
        change: 'changed',
        tools: ['set_auto_run'],
        summary: 'set_auto_run takes start_delay_s (0-600, default 0): a row waits that many seconds after its last '
          + 'change before auto-run runs it. Its answer lists each column\'s start_delay_s.',
        details: 'For rows filled in over a while (by hand, a webhook in parts, another column): each new write starts '
          + 'the wait again. Omitted keeps it; null sets 0. PUT /api/v1/sheets/{id}/enrichment-auto-run takes it too.',
      },
      {
        change: 'added',
        tools: ['manage_run_schedule'],
        summary: 'manage_run_schedule reruns a sheet\'s or a table\'s run columns on a schedule: daily, on weekdays, '
          + 'weekly, monthly or every N hours, at a time in a time zone.',
        details: 'Each firing is a column run as the token that made it (get_setup_run follows it). max_cost_usd '
          + 'refuses a firing that could cost more; last_error says why a firing didn\'t start.',
      },
      {
        change: 'added',
        tools: ['run_columns'],
        summary: 'run_columns runs several of a sheet\'s run columns again in one call, on the rows a mode picks '
          + '(among row_ids or a where), with an estimate first and an optional max_cost_usd.',
        details: 'A column reading another chosen column waits for that one\'s whole run. It answers a setup_run: '
          + 'follow it with get_setup_run, and pause, resume or stop it with control_setup_run.',
      },
      {
        change: 'changed',
        tools: ['get_setup_run', 'control_setup_run'],
        summary: 'A column run (run_columns) shows as a setup run with no setup: setup_id null, column_run with its '
          + 'mode and rows, and a step for each column (kind can be waterfall).',
      },
    ],
  },
  {
    version: 'v0.8.43',
    changes: [
      {
        change: 'changed',
        tools: ['hiring_signals'],
        summary: 'hiring_signals create takes min_roles (companies with fewer matching roles get no Companies row) '
          + 'and leave_out_companies (websites that get none). Their roles are still searched and paid for.',
        details: 'create and get answer them, and each check\'s companies_kept_off, only for a table made with '
          + 'them. Refused: a company in both companies and leave_out_companies (careers.ramp.com is ramp.com), or '
          + 'a left-out website no company can have.',
      },
      {
        change: 'changed',
        tools: ['waterfall_column', 'run_enrichment', 'apply_setup', 'control_run'],
        summary: 'A provider name in provider_order or skip_providers that treg\'s catalog doesn\'t list for the '
          + 'tool is refused, with the names it knows. It used to be dropped without a word, so a misspelled skip '
          + 'kept nothing out.',
        details: 'A name saved on a column before treg dropped that provider is ignored, not refused, and named in '
          + 'the answer\'s notes. A list for a tool whose providers the catalog doesn\'t list right now is '
          + 'refused: try again, or leave the list out.',
      },
    ],
  },
  {
    version: 'v0.8.38',
    changes: [
      {
        change: 'changed',
        tools: ['hiring_signals'],
        summary: 'hiring_signals create takes description_words (only roles whose description mentions one), '
          + 'leave_out_description_words, leave_out_title_words, seniority, employment_types and companies.',
        details: 'A table made with any of them has a Searches column for each and searches the one job index that '
          + 'takes them; create answers them. check\'s free count takes them all.',
      },
    ],
  },
  {
    version: 'v0.8.32',
    changes: [
      {
        change: 'added',
        tools: ['hiring_signals'],
        summary: 'New tool hiring_signals: a table of the companies hiring for chosen roles, and what is new at each '
          + 'check. create is free; check is paid and estimates first.',
        details: 'check with estimate_only:false and max_cost_usd (the estimate\'s high_usd) starts one enrichment '
          + 'run (follow it with get_run_status) adding only roles never found before, then sums up Companies: '
          + 'read_rows with New roles > 0.',
      },
    ],
  },
  {
    version: 'v0.8.17',
    changes: [
      {
        change: 'changed',
        tools: ['get_run_status'],
        summary: 'get_run_status with wait_seconds answers when the run\'s status changes (it ends, pauses or fails) '
          + 'or the time is up, no longer at each batch of rows.',
        details: 'For progress on the way, pass a short wait_seconds: every answer has processed_rows. With 10 waits '
          + 'of your account already open, it answers at once with waited: false and retry_after_seconds.',
      },
      {
        change: 'changed',
        tools: ['transfer_rows'],
        summary: 'transfer_rows refusing a column the destination lacks (column_mode require_existing) names the '
          + 'destination\'s close columns, and the ways on: columns, column_mapping or column_mode create_missing.',
        details: 'Into a brand-new sheet (only its starter column and blank rows), it names only column_mode '
          + 'create_missing: the other ways are refused there the same way.',
      },
    ],
  },
  {
    version: 'v0.8.16',
    changes: [
      {
        change: 'added',
        tools: ['get_workspace'],
        summary: 'get_workspace says where you are in one call: your token\'s scopes and spend, the enrichment daily '
          + 'limit, the tables and sheets changed most recently, and the runs going now. Call it first.',
        details: 'It lists at most 20 tables, 50 sheets, and 20 runs and setup runs, with the totals, and counts rows '
          + 'up to 10,000 (row_count_at_least: true means more). note names the tool that lists what it left out.',
      },
      {
        change: 'server',
        summary: 'A tool error for an unknown sheet, table, column, run or setup adds the close matches among yours '
          + '(names and ids), or says it is in the trash, and names the tool that lists them.',
        details: 'Call again with an id it names. An error listing many unknown columns gets close matches for the '
          + 'first 5. apply_setup\'s names get the setup\'s own columns. The tool\'s own words still come first, so a '
          + 'check on them still works.',
      },
      {
        change: 'server',
        summary: 'Arguments that do not fit a tool\'s input schema are refused in plain words: the field, what it '
          + 'takes (its type, range or choices) and what was sent.',
        details: 'It is still a tool result with isError that starts "Input validation error: Invalid arguments for '
          + 'tool <name>:". A message a field sets itself (such as max_chars_per_cell\'s range) is unchanged.',
      },
      {
        change: 'server',
        summary: 'A refusal for a missing scope also says how to get it: the user makes a token with that scope '
          + 'ticked in Cubex (Settings, then Agent access).',
      },
      {
        change: 'server',
        summary: 'A tools/call whose arguments are not an object still gets -32602, now naming what was wrong in '
          + 'plain words instead of the raw list of issues.',
        details: 'A request whose MCP-Protocol-Version header names a version Cubex does not speak gets 400 with '
          + '-32022 and every version it speaks in data.supported, as the 2026-07-28 transport asks.',
      },
      {
        change: 'server',
        summary: 'The server instructions are half as long and start with get_workspace; each tool\'s description '
          + 'says the rest.',
      },
      {
        change: 'server',
        summary: 'Every tool that writes answers changed: for each sheet it wrote, the columns and rows it touched, '
          + 'row_ids (the first 100) and the sheet\'s data_version and row_generation after it.',
        details: '[] for a preview, dry run, estimate, or a sheet or table renamed, moved or deleted; a replay '
          + 'answers the first call\'s. more_coming: true means a run or fill goes on, so read again later. Tools '
          + 'that write no sheet data leave it out.',
      },
    ],
  },
  {
    version: 'v0.8.14',
    changes: [
      {
        change: 'changed',
        tools: ['get_version'],
        summary: 'get_version takes since, a release like "v0.8.13", and then adds changes_since: what changed for '
          + 'agents in every release after it, oldest first.',
        details: 'Call it with the version you last used when you start on a server you have used before, or when a '
          + 'tool you expect is missing.',
      },
      {
        change: 'server',
        summary: 'The server instructions start with the running Cubex version and what changed for agents in it.',
      },
      {
        change: 'server',
        summary: 'A call to a tool a release removed or renamed gets a tool error naming what replaced it, instead of '
          + '"Tool not found".',
        details: 'Call the tool it names, and list the tools again: your list is older than the server.',
      },
      {
        change: 'server',
        summary: 'Every tool declares an outputSchema in tools/list: the fields its structuredContent holds.',
        details: 'The schemas are open: a later release may add fields, so ignore the ones you do not know. A '
          + 'field marked optional is there only in some cases (an estimate, a preview, a dry run).',
      },
      {
        change: 'server',
        summary: 'The where language is described once, on read_rows\' where, and the "Only run if" rule language '
          + 'once, on check_run_condition; the other tools\' where and run_if point there.',
        details: 'Their shape is unchanged: the same where and run_if work on every tool that takes them.',
      },
    ],
  },
  {
    version: 'v0.8.13',
    changes: [
      {
        change: 'added',
        tools: ['get_version'],
        summary: 'New tool get_version: the running Cubex version, the latest release and whether it is newer.',
        details: 'It takes no arguments and costs nothing. update_available is null when it cannot be told: a build '
          + 'that is not a release, or no answer from the daily release check yet.',
      },
      {
        change: 'server',
        summary: 'serverInfo.version is the running Cubex version (like "v0.8.13"), not "1.0.0".',
        details: 'A build that is not a release reports its build line, and one that does not record its version '
          + 'reports "unknown".',
      },
    ],
  },
];
