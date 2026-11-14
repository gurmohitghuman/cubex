// What changed for agents, release by release: tools added, changed, removed or renamed, and changes to the
// server's answers. Agents read it three ways (services/version-changes.ts): the server instructions name
// the running release and what changed in it, get_version with since lists every release after a version,
// and a call to a removed or renamed tool says what replaced it.
//
// A change to a tool's name or input schema needs a line here, under the release it will ship in (the next
// one after the latest tag; rename it if that release gets another number). tests/unit/mcp-tool-list.test.ts
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
