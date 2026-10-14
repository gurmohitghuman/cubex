// The clean data cleaners, mirrored from server/src/lib/clean/cleaners.ts (the
// server is authoritative and checks every value): their ids, the dialog's
// labels, groups and help, the phone formats, and the default column name
// ("<source> (<suffix>)"), which the server computes the same way.

export const CLEANER_IDS = [
  'person_name', 'first_name', 'last_name', 'company_name', 'email', 'domain', 'phone',
  'title_case', 'lowercase', 'trim',
] as const
export type CleanerId = typeof CLEANER_IDS[number]

export const CLEANER_GROUPS = ['People', 'Company', 'Contact', 'Text'] as const
export type CleanerGroup = typeof CLEANER_GROUPS[number]

export interface CleanerInfo { id: CleanerId; label: string; group: CleanerGroup; help: string; suffix: string }

export const CLEANERS: readonly CleanerInfo[] = [
  {
    id: 'person_name', label: 'Full name', group: 'People', suffix: 'clean',
    help: 'Fixes words typed in ALL CAPS or lowercase, turns "Smith, John" around, '
      + 'drops Mr, Dr, Jr, PhD and nicknames.',
  },
  {
    id: 'first_name', label: 'First name', group: 'People', suffix: 'first name',
    help: 'The first name, from a full name in any of those shapes.',
  },
  {
    id: 'last_name', label: 'Last name', group: 'People', suffix: 'last name',
    help: 'The last name, keeping words like van and de la.',
  },
  {
    id: 'company_name', label: 'Company name', group: 'Company', suffix: 'clean',
    help: 'Drops Inc, LLC, Corp, Ltd, GmbH and other legal endings, and fixes ALL CAPS.',
  },
  {
    id: 'email', label: 'Email', group: 'Contact', suffix: 'clean',
    help: "Lowercases the address and leaves it blank when the format is invalid. It doesn't check that mail "
      + 'gets delivered.',
  },
  {
    id: 'domain', label: 'Domain', group: 'Contact', suffix: 'domain',
    help: 'The root domain of a website or an email: https://blog.acme.co.uk/about and pat@acme.co.uk both give '
      + 'acme.co.uk.',
  },
  {
    id: 'phone', label: 'Phone', group: 'Contact', suffix: 'clean',
    help: "One format for every number. Blank when it isn't a real phone number.",
  },
  {
    id: 'title_case', label: 'Title Case', group: 'Text', suffix: 'clean',
    help: 'Capitalizes each word, keeps small words like of and and lowercase, and acronyms like CEO and VP upper.',
  },
  { id: 'lowercase', label: 'lowercase', group: 'Text', suffix: 'clean', help: 'Every letter lowercase.' },
  {
    id: 'trim', label: 'Remove extra spaces', group: 'Text', suffix: 'clean',
    help: 'Removes spaces at the ends, extra spaces and line breaks inside, and invisible characters.',
  },
]

export const isCleanerId = (x: unknown): x is CleanerId =>
  typeof x === 'string' && (CLEANER_IDS as readonly string[]).includes(x)

export const cleanerInfo = (id: string): CleanerInfo | undefined => CLEANERS.find(c => c.id === id)

// A cleaner this version doesn't know shows by its id.
export const cleanerLabel = (id: string): string => cleanerInfo(id)?.label ?? id

export const defaultCleanColumnName = (cleaner: CleanerId, source: string): string =>
  `${source} (${cleanerInfo(cleaner)!.suffix})`

// The phone cleaner's options: how numbers are written, and the country whose
// numbers have no country code (two letters, US by default).
export type PhoneFormat = 'national' | 'international' | 'e164'
export const PHONE_FORMATS: ReadonlyArray<{ id: PhoneFormat; label: string; example: string }> = [
  { id: 'national', label: 'Local', example: '(212) 555-0123' },
  { id: 'international', label: 'International', example: '+1 212 555 0123' },
  { id: 'e164', label: 'International, no spaces', example: '+12125550123' },
]
export const DEFAULT_PHONE_FORMAT: PhoneFormat = 'national'
export const DEFAULT_PHONE_COUNTRY = 'US'
