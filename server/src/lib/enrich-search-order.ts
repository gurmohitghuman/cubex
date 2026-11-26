// The order the drawer and search_enrichments list a search's tools in (pure). treg ranks by how well each
// tool's words match, so one job's providers come in a run ("tiktok viral videos": five of a user's videos
// before any search), and a tool of another platform can match on its words alone (YouTube's trending
// Shorts, "viral videos"). So, keeping treg's order within each group:
//   1. tools treg's own keys run before those needing the team's own provider key;
//   2. when the words name a platform among the results (its id, or a name in brackets in its label: "X
//      (Twitter)"), that platform's tools before the others;
//   3. each job's first tool keeps its place among the jobs, and the job's other tools follow after every
//      job's first (a Popular job shown above the results is its job's first). A tool with no job counts as
//      its own.
export interface Ordered { id: string; capability: string | null; platformLabel: string | null; needsOwnKey: boolean }

export function firstOfEachJob<T extends { id: string; capability: string | null }>(tools: T[],
  shownJobs: Iterable<string> = []): T[] {
  const seen = new Set<string>(shownJobs);
  const first: T[] = [];
  const rest: T[] = [];
  for (const t of tools) {
    const job = t.capability ?? `tool:${t.id}`;
    if (seen.has(job)) rest.push(t);
    else { seen.add(job); first.push(t); }
  }
  return [...first, ...rest];
}

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

function platformNames(platform: string | null, label: string | null): string[] {
  const aliases = [...(label ?? '').matchAll(/\(([^)]+)\)/g)].flatMap(m => words(m[1]));
  return [...(platform ? [platform.toLowerCase()] : []), ...aliases];
}

export function searchOrder<T extends Ordered>(tools: T[], query: string, platformOf: (t: T) => string | null,
  shownJobs: string[] = []): T[] {
  const asked = new Set(words(query));
  const named = (t: T) => platformNames(platformOf(t), t.platformLabel).some(n => asked.has(n));
  const anyNamed = tools.some(named);
  const groups: T[][] = [[], [], [], []];
  for (const t of tools) groups[(t.needsOwnKey ? 2 : 0) + (anyNamed && !named(t) ? 1 : 0)].push(t);
  return groups.flatMap(g => firstOfEachJob(g, shownJobs));
}
