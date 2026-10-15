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

// A first guess from a clean column's cleaner or the column's name. A URL
// column stays text: "linkedin.com/in/jo" isn't a company's website.
export function guessDedupeMatch(column: string, cleaner?: string): DedupeMatch {
  if (cleaner && BY_CLEANER[cleaner]) return BY_CLEANER[cleaner]
  const c = column.toLowerCase().trim()
  if (/\be-?mail\b/.test(c) && !ABOUT.test(c)) return 'email'
  if (/\b(domain|website|web site|homepage)\b/.test(c) && !ABOUT.test(c)) return 'domain'
  if (/\b(phone|mobile|cell)\b/.test(c) && !ABOUT.test(c)) return 'phone'
  if (/^(company|organi[sz]ation|employer|account)( name)?$/.test(c)) return 'company'
  if (/^(full |contact |person )?name$/.test(c)) return 'person_name'
  return 'text'
}

// The column the dialog opens on: the one that tells people apart best (an
// email, then a phone, a full name, a domain, a company), the first of a
// kind in sheet order; else the first column.
const RANK: DedupeMatch[] = ['email', 'phone', 'person_name', 'domain', 'company']
export function pickDedupeColumn(
  columns: string[], cleanerOf: (column: string) => string | undefined,
): string | undefined {
  for (const match of RANK) {
    const hit = columns.find(c => guessDedupeMatch(c, cleanerOf(c)) === match)
    if (hit) return hit
  }
  return columns[0]
}
