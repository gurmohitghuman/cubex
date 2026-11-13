// What changed for agents, release by release: tools added, changed, removed or renamed, and changes to the
// server's answers. Agents read it three ways (services/version-changes.ts): the server instructions name
// the running release and what changed in it, get_version with since lists every release after a version,
// and a call to a removed or renamed tool says what replaced it.
//
// A change to a tool's name or input schema needs a line here, under the release it will ship in (the next
// one after the latest tag; rename it if that release gets another number). tests/unit/mcp-tool-list.test.ts
// compares the tools with the list recorded for the last release (tests/unit/mcp-tool-list.json) and fails
// on a change without a line. A change agents should know about that the schema doesn't show (a new field
// in an answer, a new refusal) gets a line too. Write each line for an agent: what it calls now, and what
// it does differently.

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
    version: 'v0.8.13',
    changes: [
      {
        change: 'added',
        tools: ['get_version'],
        summary: 'New tool get_version: the running Cubex version, whether a newer release is out, and with since, '
          + 'what changed for agents after a version.',
        details: 'Call it when you start on a server you have used before, or when a tool you expect is missing: '
          + 'pass the version you last saw as since to get every change after it.',
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
