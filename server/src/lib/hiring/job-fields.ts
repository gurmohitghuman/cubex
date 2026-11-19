// Where each job search provider keeps a role's title, company, domain, team,
// place, posting day and link in its own rows (pure). treg answers every
// provider's own row shape, so a hiring search keeps the fields of the one
// provider its run asks. Paths come from treg's catalog examples; a provider
// whose example doesn't show a field leaves its column empty. A role is told
// apart by its link, else the provider's job id (one key under the link's
// path, so a role keeps its key when only one of them is there).
import type { ListField } from '../enrich-list';
import { ROLE_COLUMNS, type RoleColumn } from './names';

type Paths = Partial<Record<Exclude<RoleColumn, 'firstSeen' | 'search'>, string>> & {
  link: string; also?: string[];
};

const PROVIDERS: Record<string, Paths> = {
  hirebase: {
    title: '$.job_title', company: '$.company_name', domain: '$.company_link', team: '$.team',
    location: '$.location_raw', posted: '$.date_posted', link: '$.application_link', also: ['$._id'],
  },
  jobspipe: {
    title: '$.job_title', company: '$.company', domain: '$.company_domain', location: '$.location',
    posted: '$.date_posted', link: '$.final_url', also: ['$.url', '$.id'],
  },
  crustdata: { title: '$.job_details.title', company: '$.company.basic_info.name', link: '$.job_details.url' },
  theirstack: {
    title: '$.job_title', company: '$.company', domain: '$.company_domain', location: '$.location',
    posted: '$.date_posted', link: '$.url', also: ['$.id'],
  },
  predictleads: {
    title: '$.attributes.title', posted: '$.attributes.first_seen_at', link: '$.attributes.url', also: ['$.id'],
  },
};
// Any other provider: the common names.
const COMMON: Paths = {
  title: '$.title', company: '$.company', domain: '$.domain', location: '$.location', posted: '$.posted_at',
  link: '$.url', also: ['$.id'],
};

const ORDER = ['title', 'company', 'domain', 'team', 'location', 'posted', 'link'] as const;

export interface JobFields { fields: ListField[]; dedupePath: string; dedupeAlso: string[] }

export function jobFields(provider: string | null): JobFields {
  const p = PROVIDERS[(provider ?? '').toLowerCase()] ?? COMMON;
  const fields = ORDER.flatMap(k => (p[k] ? [{ path: p[k]!, columnName: ROLE_COLUMNS[k] }] : []));
  return { fields, dedupePath: p.link, dedupeAlso: p.also ?? [] };
}
