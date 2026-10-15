// Remove duplicates: how a column can match and which row stays, mirrored from
// server/src/lib/dedupe/key.ts (the server is authoritative and checks every
// value), with the dialog's labels and help, and a first guess at a column's match.

export type DedupeMatch = 'text' | 'email' | 'domain' | 'phone' | 'company' | 'person_name'
export type DedupeKeep = 'first' | 'last' | 'most_complete'

export const DEDUPE_MATCHES: ReadonlyArray<{ id: DedupeMatch; label: string; help: string }> = [
  { id: 'text', label: 'Text', help: 'The same text. Upper/lower case and extra spaces never matter.' },
  {
    id: 'email', label: 'Email',
    help: '"Jo@Acme.com" matches "jo@acme.com". A value that isn\'t an email never matches.',
  },
  {
    id: 'domain', label: 'Website or domain',
    help: '"https://www.acme.com/about", "jo@acme.com" and "acme.com" all match. A Gmail address never matches '
      + 'by domain, and a Facebook or LinkedIn page only matches the same page.',
  },
  {
    id: 'phone', label: 'Phone',
    help: '"(212) 555-0123" matches "+1 212 555 0123". Numbers without a country code read as US.',
  },
  { id: 'company', label: 'Company name', help: '"Acme, Inc." matches "ACME LLC".' },
  { id: 'person_name', label: 'Person name', help: '"Smith, John" matches "john smith".' },
]

export const DEDUPE_KEEPS: ReadonlyArray<{ id: DedupeKeep; label: string; help: string }> = [
  { id: 'first', label: 'First row', help: 'The highest row of each group stays.' },
  { id: 'last', label: 'Last row', help: 'The lowest row of each group stays, usually the newest.' },
  {
    id: 'most_complete', label: 'Most filled-in row',
    help: 'The row with the most filled cells stays (the highest of a tie).',
  },
]

// A clean column already holds tidy values: match it the way it was cleaned.
const BY_CLEANER: Record<string, DedupeMatch> = {
  email: 'email', domain: 'domain', phone: 'phone', company_name: 'company', person_name: 'person_name',
}

// A column ABOUT an email or a phone (its status, whether it was verified,
// when it was sent) holds no address or number.
const ABOUT = /\b(status|verified|verification|valid|validity|type|sent|opened|clicked|bounced?|date|count|score)\b/

// A sheet of people, not companies: it has a first, last, full or contact
// name column, or a job title. On any other sheet a bare "Name" column holds
// a company's name (a list of companies from a search or a scrape).
const PERSON_COLUMN = /^(first|last|full|contact|person)[ _-]?name$|^(job )?title$/
export const isPeopleSheet = (columns: string[]): boolean =>
  columns.some(c => PERSON_COLUMN.test(c.toLowerCase().trim()))

// A first guess from a clean column's cleaner or the column's name. A URL
// column stays text: "linkedin.com/in/jo" isn't a company's website.
export function guessDedupeMatch(column: string, cleaner?: string, people = true): DedupeMatch {
  if (cleaner && BY_CLEANER[cleaner]) return BY_CLEANER[cleaner]
  const c = column.toLowerCase().trim()
  if (/\be-?mail\b/.test(c) && !ABOUT.test(c)) return 'email'
  if (/\b(domain|website|web site|homepage)\b/.test(c) && !ABOUT.test(c)) return 'domain'
  if (/\b(phone|mobile|cell)\b/.test(c) && !ABOUT.test(c)) return 'phone'
  if (/^(company|organi[sz]ation|employer|account)( name)?$/.test(c)) return 'company'
  if (/^(full |contact |person )?name$/.test(c)) return c === 'name' && !people ? 'company' : 'person_name'
  return 'text'
}

export interface DedupeKeyGuess { column: string; match: DedupeMatch }

// The columns the dialog opens on, never one that would merge different
// people or companies by itself: an email; else, on a people sheet, the name
// together with the company (its domain first), or a phone, or the name
// alone; on any other sheet the domain, the company name or a phone; else
// the first column as text. The check shows the groups before anything goes.
export function pickDedupeKeys(
  columns: string[], cleanerOf: (column: string) => string | undefined,
): DedupeKeyGuess[] {
  const people = isPeopleSheet(columns)
  const typed = columns.map(column => ({ column, match: guessDedupeMatch(column, cleanerOf(column), people) }))
  const find = (m: DedupeMatch) => typed.find(k => k.match === m)
  const named = (re: RegExp) => typed.find(k => re.test(k.column.toLowerCase().trim()))
  const email = find('email')
  if (email) return [email]
  if (people) {
    const full = find('person_name')
    const first = named(/^first[ _-]?name$/), last = named(/^last[ _-]?name$/)
    const names = full ? [full] : first && last ? [first, last] : []
    const where = find('domain') ?? find('company')
    if (names.length > 0 && where) return [...names, where]
    const phone = find('phone')
    if (phone) return [phone]
    if (names.length > 0) return names
  } else {
    const key = find('domain') ?? find('company') ?? find('phone')
    if (key) return [key]
  }
  return typed.slice(0, 1)
}
