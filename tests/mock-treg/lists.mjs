// List jobs (people.search, companies.search, google.serp.organic, YouTube search, comments): like
// live treg, each provider answers with its own row shape (treg doesn't make
// them alike) under the contract's list field, at most `limit` rows. Rows are
// a pure function of the search (a domain, a name or a query) and the
// provider, so two rows searching the same company get the same people (the
// duplicate check has something to find). All names are fictional.
// Steering (/__mock/state): listSizes {word: n} caps a search mentioning
// `word` at n rows (0: an answer with an empty list, count 0); "nobody"
// anywhere in the request finds none (a miss).
import { fixture, state } from './state.mjs'
import { jobRows } from './jobs.mjs'

const PEOPLE = ['Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Katherine Johnson', 'Edsger Dijkstra',
  'Barbara Liskov', 'Donald Knuth', 'Margaret Hamilton', 'Ken Thompson', 'Frances Allen', 'John Backus',
  'Radia Perlman', 'Dennis Ritchie', 'Shafi Goldwasser', 'Tim Berners', 'Hedy Lamarr']
const TITLES = ['VP Engineering', 'Head of Sales', 'Staff Engineer', 'Product Manager', 'CTO', 'Founder']
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

const person = {
  quickenrich: (n, i, key) => ({
    first_name: n.split(' ')[0], last_name: n.split(' ')[1], title: TITLES[i % TITLES.length],
    employee_linkedin: `https://www.linkedin.com/in/${slug(n)}-${slug(key)}`, company_url: key,
    company_name: key.split('.')[0], city: 'Springfield', country_code: 'US',
  }),
  leadsforge: (n, i, key) => ({
    id: `lf-${slug(key)}-${i}`, firstName: n.split(' ')[0], lastName: n.split(' ')[1],
    jobTitle: TITLES[i % TITLES.length], linkedinUrl: `https://www.linkedin.com/in/${slug(n)}-${slug(key)}`,
    location: { city: 'Springfield', country: 'United States' }, company: { domain: key, name: key.split('.')[0] },
  }),
}
const genericPerson = (n, i, key) => ({
  name: n, title: TITLES[i % TITLES.length], profile_url: `https://people.example/${slug(n)}-${slug(key)}`,
})

const ROWS = {
  people: (provider, i, key) => (person[provider] ?? genericPerson)(PEOPLE[i % PEOPLE.length], i, key),
  companies: (provider, i, key) => ({
    name: `${slug(key)} peer ${i + 1}`, domain: `${slug(key)}-peer-${i + 1}.example`, industry: 'Software',
    employees: 50 + i * 10, ...(provider === 'akta' ? { country: 'US' } : {}),
  }),
  // A social research table's YouTube search (one provider's shape: lib/social/platforms.ts) and its comments.
  videos: (provider, i, key) => ({
    video_id: `vid${slug(key).slice(0, 6)}${i}`, title: `${key}: my week ${i + 1}`, author: `Channel ${i + 1}`,
    number_of_views: 90000 - i * 1000, published_time: `${i + 1} days ago`, channel_id: `UC${i}sample`,
  }),
  comments: (provider, i, key) => ({
    id: `c-${slug(key).slice(-12)}-${i}`, comment_id: `c-${slug(key).slice(-12)}-${i}`, text: `Comment ${i + 1}`,
    author: PEOPLE[i % PEOPLE.length].split(' ')[0].toLowerCase(), likes: 10 - i, replies: i % 3,
  }),
  results: (provider, i, key) => ({
    position: i + 1, title: `Result ${i + 1} for ${key}`, link: `https://site${i + 1}.example/${slug(key)}`,
    snippet: `What ${provider} found about ${key}.`,
  }),
}

// A field that holds rows, either way treg's catalog writes it: the old word
// "list", or an array of objects (as the live catalog has since November 2026).
export const isRowList = d => d?.type === 'list'
  || ([d?.type].flat().includes('array') && [d?.items?.type].flat().includes('object'))

// The contract's list field ("people"), or null when the job doesn't return a list.
export function listField(toolId) {
  const output = fixture(`catalog/endpoints/${toolId}.json`).routing?.contract?.output ?? {}
  return Object.entries(output).find(([, d]) => isRowList(d))?.[0] ?? null
}

export function listAnswer(toolId, p, body) {
  const field = listField(toolId)
  if (field === 'jobs') {
    if (JSON.stringify(body ?? {}).toLowerCase().includes('nobody')) return {}
    const jobs = jobRows(p.provider, body)
    return jobs.length ? { output: { jobs, count: jobs.length } } : {}
  }
  const key = String(body.company_domain ?? body.domain ?? body.q ?? body.name ?? body.title ?? body.url
    ?? body.video_id ?? 'x').toLowerCase()
  if (JSON.stringify(body ?? {}).toLowerCase().includes('nobody')) return {}
  const capped = Object.entries(state.listSizes ?? {}).find(([w]) => key.includes(w.toLowerCase()))
  const n = Math.min(Number(body.limit ?? 10), capped ? Number(capped[1]) : 10)
  const rows = Array.from({ length: Math.max(0, n) }, (_, i) => (ROWS[field] ?? ROWS.results)(p.provider, i, key))
  return rows.length || capped ? { output: { [field]: rows, count: rows.length } } : {}
}
