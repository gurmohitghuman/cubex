// The buyer on each Companies row (pure): the person a company hiring for these roles would buy through, found by
// job title, with a verified work email (plans/find-jobs-buyer.md, services/hiring-buyer.ts). One person per company,
// on its own row: Findymail's search of a company's people by job title (every title in one call, one person back,
// billed only when it finds one), then the verified-email preset on that person's name and LinkedIn. A company with
// no such person leaves the email's inputs empty, so its email is skipped and costs nothing.
import type { EnrichRunInput } from '../enrich-run-input';
import { BUYER_COLUMNS, COMPANY_COLUMNS } from './names';

export const BUYER_TOOL_ID = 'findymail.search.employees';
export const BUYER_EMAIL_TOOL_ID = 'treg.people.email.find';
// Titles a search takes at most, and a title's length.
export const BUYER_MAX_TITLES = 6;
export const BUYER_MAX_TITLE_CHARS = 80;

// The starting titles: a role title matching a row's words (whole words, any case, a plural's s ignored) gives its
// titles; the first match wins. Sales and marketing first: they are what hiring signals are mostly sold to.
const STARTING: ReadonlyArray<[RegExp, string[]]> = [
  [/\b(sdrs?|bdrs?|sales development|business development)\b/,
    ['Head of Sales Development', 'VP Sales', 'Head of Sales']],
  [/\b(revops|revenue operations|sales operations|sales ops)\b/,
    ['Head of Revenue Operations', 'VP Revenue Operations', 'Chief Revenue Officer']],
  [/\b(account executives?|aes?|sales)\b/, ['VP Sales', 'Head of Sales', 'Chief Revenue Officer']],
  [/\b(marketing|demand gen(eration)?|growth)\b/, ['VP Marketing', 'Head of Marketing', 'Chief Marketing Officer']],
  [/\b(customer success|account managers?|support)\b/, ['VP Customer Success', 'Head of Customer Success']],
  [/\b(product managers?|product owners?)\b/, ['VP Product', 'Head of Product']],
  [/\b(engineers?|engineering|developers?|software|devops)\b/, ['VP Engineering', 'Head of Engineering', 'CTO']],
  [/\b(data|analysts?|analytics)\b/, ['Head of Data', 'VP Data']],
  [/\b(recruiters?|recruiting|talent)\b/, ['Head of Talent', 'VP People']],
  [/\b(designers?|design)\b/, ['Head of Design']],
  [/\b(finance|accountants?|accounting|controllers?)\b/, ['CFO', 'VP Finance']],
];

// The titles "Find buyers" starts with for these role titles, in order, each once, at most BUYER_MAX_TITLES; none
// when no role matches (the person types them).
export function buyerTitlesFor(roles: readonly string[]): string[] {
  const out: string[] = [];
  for (const role of roles) {
    const words = role.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
    const hit = STARTING.find(([re]) => re.test(words));
    for (const t of hit?.[1] ?? []) if (!out.includes(t)) out.push(t);
  }
  return out.slice(0, BUYER_MAX_TITLES);
}

// Titles as given (a list, or a comma or line list): trimmed, each once (any case); a refusal in plain words.
export function parseBuyerTitles(v: unknown, field: string): string[] | string {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\n]/) : null;
  if (!raw || raw.some(t => typeof t !== 'string')) return `${field} must be a list of job titles.`;
  const out: string[] = [];
  for (const t of raw as string[]) {
    const title = t.replace(/\s+/g, ' ').trim();
    if (!title) continue;
    if (title.length > BUYER_MAX_TITLE_CHARS) return `A title in ${field} is over ${BUYER_MAX_TITLE_CHARS} characters.`;
    if (!out.some(o => o.toLowerCase() === title.toLowerCase())) out.push(title);
  }
  if (out.length === 0) return `${field} needs at least one job title, such as Head of Sales.`;
  if (out.length > BUYER_MAX_TITLES) return `${field} takes at most ${BUYER_MAX_TITLES} job titles.`;
  return out;
}

const base = (toolId: string, columnName: string): EnrichRunInput => ({
  toolId, preset: null, columnName, continueColumn: false, inputs: {}, cleanDomains: false, providerOrder: [],
  skipProviders: [], stopAtFirst: false, email: null, outputs: [],
  rows: { mode: 'all', status: 'any', test: null, rowIndexes: null }, conditions: [], runIf: null,
  maxCostPerRowUsd: null, spendLimitUsd: null, concurrency: null, fresh: false, rowGeneration: null, list: null,
  saveOnly: true,
});

// The people search, saved as a setup: the company's website, the titles, one person. again: its column is there
// (new titles save its setup again; its cells stay). perRowUsd: the tool's price for one person, its most a company
// (Cubex prices a per-result tool as a page of 20; Findymail's own dial is count, sent as 1); null: the default.
export function buyerSearchInput(titles: readonly string[], again: boolean, perRowUsd: number | null): EnrichRunInput {
  return {
    ...base(BUYER_TOOL_ID, BUYER_COLUMNS.search), continueColumn: again, maxCostPerRowUsd: perRowUsd,
    inputs: { website: { column: COMPANY_COLUMNS.domain }, job_titles: { value: JSON.stringify(titles) },
      count: { value: '1' } },
    outputs: [
      { key: 'name', path: '$[0].name', columnName: BUYER_COLUMNS.name },
      { key: 'jobTitle', path: '$[0].jobTitle', columnName: BUYER_COLUMNS.title },
      { key: 'linkedinUrl', path: '$[0].linkedinUrl', columnName: BUYER_COLUMNS.linkedin },
    ],
  };
}

// The verified email, saved as a setup, with the drawer's defaults: treg's email finder on the buyer's name or
// LinkedIn at the company's domain, a first.last guess first, each address checked (the preset's own loop and per-row
// cap), only addresses the checker calls valid kept.
export function buyerEmailInput(): EnrichRunInput {
  return {
    ...base(BUYER_EMAIL_TOOL_ID, BUYER_COLUMNS.emailSearch), preset: 'verified_email',
    inputs: { domain: { column: COMPANY_COLUMNS.domain }, full_name: { column: BUYER_COLUMNS.name },
      linkedin_url: { column: BUYER_COLUMNS.linkedin } },
    email: { accept: 'safest', guess: true, pattern: 'first.last' },
    outputs: [
      { key: 'email', path: '$.output.email', columnName: BUYER_COLUMNS.email },
      { key: 'email_status', path: null, columnName: BUYER_COLUMNS.emailStatus },
    ],
  };
}

// The titles a saved people search holds (its job_titles input), or null.
export function titlesOfInput(templates: Record<string, string>): string[] | null {
  try {
    const v = JSON.parse(templates.job_titles ?? 'null');
    return Array.isArray(v) && v.every(t => typeof t === 'string') ? v : null;
  } catch { return null; }
}
