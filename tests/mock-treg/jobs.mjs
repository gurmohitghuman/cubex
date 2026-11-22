// Job searches (treg.companies.jobs.search) and the two free job counts. Each
// provider answers its own row shape, as live: hirebase's rows carry the
// company's domain in company_link, jobspipe's in company_domain. Rows are a
// pure function of the title searched and the provider: the same search finds
// the same roles, with the same links, at every check. Of the ten roles a
// search finds, Quillmark has two, and the second comes without a domain
// (company name "Quillmark Inc."): a check sums it up by company name. All
// companies are fictional.
// Steering (/__mock/state):
//   jobsNew {word: n}: a search mentioning `word` also finds n new roles,
//     first (as a newer posting would come first), within the limit;
//   jobsOverfill: every search answers that many roles more than its limit
//     (a provider that ignores it), each billed per result;
//   jobCounts {word: n}: what a count mentioning `word` answers (default 120);
//   jobCountRefuses [field]: a count sent one of these fields answers 422, as
//     an index refusing a field it doesn't take would.
// hirebase.jobs.search called directly (a hiring table with More options):
// the same roles, each with a level, a job type and a description, and the
// filters applied as the index applies them (description words keep only
// roles that mention one, "-" words and the lists leave roles out). A count
// sent filters counts the share of those roles that pass them.
import { state } from './state.mjs'

const COMPANIES = ['Northwind Labs', 'Bluefin Data', 'Copperleaf Systems', 'Harborview Health', 'Quillmark']
const TITLES = (t) => [t, `Senior ${t}`, `${t}, Enterprise`]
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const domainOf = (company) => `${slug(company)}.io`

// The i-th role of a search: n new ones (first) are "new-0", "new-1"…
function role(key, i, isNew) {
  const company = COMPANIES[(i + key.length) % COMPANIES.length]
  const noDomain = company === 'Quillmark' && i >= 5
  const id = `${slug(key)}-${isNew ? 'new-' : ''}${i}`
  return {
    id, title: TITLES(key)[i % 3], company: noDomain ? 'Quillmark Inc.' : company,
    domain: noDomain ? null : domainOf(company), posted: `2026-11-${String(10 + (i % 9)).padStart(2, '0')}`,
    link: `https://jobs.${domainOf(company)}/roles/${id}`, place: ['Austin, TX', 'Remote', 'New York, NY'][i % 3],
  }
}

const SHAPES = {
  hirebase: r => ({
    _id: r.id, job_title: r.title, company_name: r.company, company_link: r.domain, team: 'Sales',
    location_raw: r.place, date_posted: r.posted, application_link: r.link,
  }),
  jobspipe: r => ({
    id: r.id, job_title: r.title, company: r.company, company_domain: r.domain, url: r.link, final_url: r.link,
    date_posted: `${r.posted}T09:00:00+00:00`, location: r.place,
  }),
}

export function jobRows(provider, body) {
  const key = String(body.title ?? body.name ?? body.domain ?? 'role')
  const limit = Number(body.limit ?? 10)
  const fresh = Object.entries(state.jobsNew ?? {}).find(([w]) => key.toLowerCase().includes(w.toLowerCase()))
  const n = fresh ? Number(fresh[1]) : 0
  const want = limit + Math.max(0, Number(state.jobsOverfill ?? 0))
  const roles = [...Array.from({ length: n }, (_, i) => role(key, i, true)),
    ...Array.from({ length: 10 }, (_, i) => role(key, i, false))].slice(0, Math.min(want, n + 10))
  const shape = SHAPES[provider] ?? SHAPES.hirebase
  return roles.map(shape)
}

export const isJobCount = (toolId) => toolId === 'hirebase.jobs.search.count' || toolId === 'jobspipe.jobs.search.count'
export const isJobSearch = (toolId) => toolId === 'hirebase.jobs.search'

const LEVELS = ['Entry-Level', 'Mid-Level', 'Senior', 'Junior / Associate', 'Executive']
const lower = (v) => String(v).toLowerCase()
const listOf = (v) => (Array.isArray(v) ? v.map(String) : [])
const wanted = (v) => listOf(v).filter(w => !w.startsWith('-'))
const leftOut = (v) => listOf(v).filter(w => w.startsWith('-')).map(w => lower(w.slice(1)))

// The search's roles with the fields the filters read, and those the body's filters keep.
function filtered(body) {
  const key = wanted(body.job_titles)[0] ?? 'role'
  const fresh = Object.entries(state.jobsNew ?? {}).find(([w]) => key.toLowerCase().includes(w.toLowerCase()))
  const n = fresh ? Number(fresh[1]) : 0
  const roles = [...Array.from({ length: n }, (_, i) => role(key, i, true)),
    ...Array.from({ length: 10 }, (_, i) => role(key, i, false))].map((r, i) => ({
    ...r, level: LEVELS[i % LEVELS.length], type: i % 4 === 3 ? 'Contract' : 'Full Time',
    description: i % 2 === 0 ? 'Outbound prospecting in Salesforce.' : 'Inbound leads; security clearance needed.',
  }))
  const titleOut = leftOut(body.job_titles), wordsOut = leftOut(body.keywords), words = wanted(body.keywords).map(lower)
  const levels = listOf(body.experience_levels), types = listOf(body.job_types)
  const domains = listOf(body.company_domains).map(lower)
  const kept = roles.filter(r => !titleOut.some(w => lower(r.title).includes(w))
    && !wordsOut.some(w => lower(r.description).includes(w))
    && (!levels.length || levels.includes(r.level)) && (!types.length || types.includes(r.type))
    && (!domains.length || (r.domain && domains.includes(r.domain))))
  const mentions = (r) => !words.length || words.some(w => lower(r.description).includes(w))
  return { all: roles.length, kept: kept.filter(mentions) }
}

export function jobSearchAnswer(body) {
  const { kept } = filtered(body)
  const jobs = kept.slice(0, Number(body.limit ?? 10) + Math.max(0, Number(state.jobsOverfill ?? 0))).map(r => ({
    ...SHAPES.hirebase(r), experience_level: r.level, job_type: r.type, description: r.description,
  }))
  return { jobs, total_count: kept.length, page: 1, limit: Number(body.limit ?? 10) }
}

export function jobCountAnswer(toolId, body) {
  const refused = (state.jobCountRefuses ?? []).find(f => body[f] !== undefined)
  if (refused) return { refusal: { detail: `${refused} is not a field of this endpoint` } }
  const title = String(wanted(body.job_titles)[0] ?? body.job_title_or?.[0] ?? '')
  const hit = Object.entries(state.jobCounts ?? {}).find(([w]) => title.toLowerCase().includes(w.toLowerCase()))
  const base = hit ? Number(hit[1]) : 120
  // With filters, the share of the roles that pass them.
  const f = filtered(body)
  const n = Math.round(base * f.kept.length / f.all)
  return toolId.startsWith('hirebase.') ? { cost: n }
    : { rows: n, rows_approximate: true, new_jobs_credits: n, max_rows: 10000 }
}
