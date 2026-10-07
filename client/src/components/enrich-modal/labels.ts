// treg's input and output keys as people read them, and which sheet column an
// input most likely is (pure). Providers name inputs in snake_case or
// camelCase (company_domain, fullName); a sheet's columns are whatever the
// user called them. Everything below compares normalized names.

const WORDS: Record<string, string> = { url: 'URL', id: 'ID', linkedin: 'LinkedIn', api: 'API', ceo: 'CEO', utc: 'UTC', smtp: 'SMTP', mx: 'MX' }

// "line_type" → "Line type", "linkedin_url" → "LinkedIn URL", "fullName" → "Full name".
export function humanize(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s._-]+/).filter(Boolean).map(w => w.toLowerCase())
  if (words.length === 0) return key
  const out = words.map(w => WORDS[w] ?? w)
  out[0] = out[0].charAt(0).toUpperCase() + out[0].slice(1)
  return out.join(' ')
}

export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

const LABELS: Record<string, string> = {
  domain: 'Company domain', companydomain: 'Company domain', q: 'Search words', limit: 'Results per row',
}

// In a company job, `name` is the company's name.
const isCompanyJob = (capability: string | null) => !!capability && capability.startsWith('companies.')

export function inputLabel(key: string, capability: string | null): string {
  if (key === 'name' && isCompanyJob(capability)) return 'Company name'
  return LABELS[norm(key)] ?? humanize(key)
}

const DOMAIN = ['domain', 'companydomain', 'website', 'companywebsite', 'websiteurl', 'url', 'site', 'web']
const LINKEDIN = ['linkedinurl', 'linkedin', 'linkedinprofile', 'linkedinprofileurl', 'personlinkedin', 'linkedinlink']
// Keyed by the normalized input name, so company_domain and companyDomain match alike.
const SYNONYMS: Record<string, string[]> = {
  domain: DOMAIN,
  companydomain: DOMAIN,
  website: ['website', 'companywebsite', 'websiteurl', 'domain', 'companydomain', 'url', 'site'],
  fullname: ['fullname', 'name', 'personname', 'contactname', 'leadname', 'person', 'contact'],
  firstname: ['firstname', 'first', 'givenname', 'fname'],
  lastname: ['lastname', 'last', 'surname', 'familyname', 'lname'],
  linkedinurl: LINKEDIN,
  profileurl: ['profileurl', ...LINKEDIN],
  linkedinhandle: ['linkedinhandle', 'linkedinusername', 'linkedinid'],
  email: ['email', 'workemail', 'emailaddress', 'businessemail', 'mail'],
  title: ['title', 'jobtitle', 'role', 'position'],
  company: ['company', 'companyname', 'organization', 'organisation', 'employer', 'account'],
  companyname: ['companyname', 'company', 'organization', 'organisation', 'account'],
  phone: ['phone', 'phonenumber', 'mobile', 'mobilephone'],
  country: ['country', 'countrycode'],
  location: ['location', 'city', 'region'],
}
const COMPANY_NAME = ['companyname', 'company', 'organization', 'organisation', 'account', 'name']

function namesFor(key: string, capability: string | null): string[] {
  const n = norm(key)
  if (n === 'name' && isCompanyJob(capability)) return COMPANY_NAME
  if (SYNONYMS[n]) return SYNONYMS[n]
  // A provider's own name for a LinkedIn profile URL (linkedinStandardProfileURL…).
  if (n.includes('linkedin') && (n.includes('url') || n.includes('profile'))) return LINKEDIN
  return [n]
}

// The column an input most likely is: an exact match on the normalized name or
// one of its usual names, in that order. No fuzzy guesses ("Email status" is
// never taken for Email); a column already taken by another input is skipped.
export function autoMatch(key: string, capability: string | null, columns: string[], taken: Set<string>): string | null {
  for (const n of namesFor(key, capability)) {
    const col = columns.find(c => !taken.has(c) && norm(c) === n)
    if (col) return col
  }
  return null
}
