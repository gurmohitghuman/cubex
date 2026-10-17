// The AI column dialog's prompt starters: a good first prompt for the usual
// jobs (qualify, classify, write an opener, score a lead, profile a company),
// written with this sheet's own columns as /references. A column is picked by
// its name (a "Company website" column is the website, "Job title" the title);
// with none that fits, the starter reads the sheet's first columns. Square
// brackets mark what the person fills in. Pure: tests/unit/prompt-starters-client.test.ts.
import { columnToken, type OutputColumnDraft } from './output-columns'

export interface SheetColumnRef { name: string; reference: string }
export type StarterId = 'qualify' | 'classify' | 'opener' | 'score' | 'profile'
export interface PromptStarter {
  id: StarterId
  label: string
  hint: string
  columnName: string
  prompt: string
  // A structured starter fills several typed columns from one answer per row.
  outputColumns: OutputColumnDraft[]
}

type Slot = 'linkedin' | 'email' | 'website' | 'firstName' | 'size' | 'industry' | 'company' | 'title' | 'name'
  | 'description' | 'location'

// First match wins, so "Company website" is the website and "Company size" the size, not the company.
const SLOT_WORDS: Array<[Slot, RegExp]> = [
  ['linkedin', /linkedin/],
  ['email', /e-?mail/],
  ['website', /website|domain|\burl\b|homepage|\bsite\b/],
  ['firstName', /first[ _-]?name|given[ _-]?name|^first$/],
  ['size', /employee|headcount|staff|company[ _-]?size|team[ _-]?size|^size$/],
  ['industry', /industry|sector|vertical/],
  ['company', /company|organi[sz]ation|account|business|employer|brand/],
  ['title', /title|job|role|position|headline|seniority/],
  ['name', /^(full[ _-]?)?name$|^contact( name)?$|^person$|^(lead|prospect)( name)?$/],
  ['description', /description|about|summary|\bbio\b|overview|tagline|keywords|notes/],
  ['location', /country|city|location|state|region|address|headquarters|\bhq\b/],
]

// A run's own status and sources columns aren't something to read.
const usable = (c: SheetColumnRef) => c.name.trim() !== '' && !/ \((Status|Data)\)$/.test(c.name)

function slotsOf(columns: SheetColumnRef[]): Partial<Record<Slot, SheetColumnRef>> {
  const out: Partial<Record<Slot, SheetColumnRef>> = {}
  for (const c of columns.filter(usable)) {
    const name = c.name.toLowerCase().trim()
    const slot = SLOT_WORDS.find(([, re]) => re.test(name))?.[0]
    if (slot && !out[slot]) out[slot] = c
  }
  return out
}

const COMPANY_DETAILS: Slot[] = ['company', 'website', 'industry', 'description', 'size', 'location', 'linkedin']
const PERSON_DETAILS: Slot[] = ['name', 'firstName', 'title', 'company', 'website', 'industry', 'description',
  'location', 'linkedin']
const FALLBACK_COLUMNS = 4

// "Name: /reference" lines for the slots a starter reads, else the sheet's first columns.
function details(columns: SheetColumnRef[], slots: Partial<Record<Slot, SheetColumnRef>>, want: Slot[]): string {
  let picked = want.map(s => slots[s]).filter((c): c is SheetColumnRef => !!c)
  if (picked.length === 0) picked = columns.filter(usable).slice(0, FALLBACK_COLUMNS)
  if (picked.length === 0) return '[Type / to add the columns it should read]'
  return [...new Set(picked)].map(c => `${c.name}: ${c.reference}`).join('\n')
}

// A name no column has yet (by /reference too, and an AI column's base name), adding " 2", " 3"... when taken.
function freeName(base: string, taken: Set<string>): string {
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base} ${n}`
    if (!taken.has(columnToken(name))) { taken.add(columnToken(name)); return name }
  }
}

function takenTokens(columns: SheetColumnRef[]): Set<string> {
  const taken = new Set<string>()
  for (const c of columns) {
    taken.add(columnToken(c.name))
    taken.add(columnToken(c.name.replace(/ \((Output|Status|Data)\)$/, '')))
  }
  return taken
}

const PROFILE_COLUMNS: OutputColumnDraft[] = [
  { columnName: 'Industry', type: 'string', description: 'The main industry it works in, in 1 to 3 words' },
  { columnName: 'Employees', type: 'number', description: 'About how many people work there' },
  { columnName: 'Headquarters', type: 'string', description: 'The city and country of its head office' },
  { columnName: 'Founded', type: 'number', description: 'The year it was founded' },
  { columnName: 'B2B', type: 'boolean', description: 'true if it mainly sells to other businesses' },
  { columnName: 'Summary', type: 'string', description: 'What it does, in one plain sentence' },
]

export function promptStarters(columns: SheetColumnRef[]): PromptStarter[] {
  const slots = slotsOf(columns)
  const company = details(columns, slots, COMPANY_DETAILS)
  const person = details(columns, slots, PERSON_DETAILS)
  const taken = takenTokens(columns)
  const who = slots.firstName?.reference ?? slots.name?.reference ?? 'this person'
  return [
    {
      id: 'qualify', label: 'Qualify (YES/NO)', hint: 'Answers YES or NO: is this company a fit?',
      columnName: freeName('Qualified', taken), outputColumns: [],
      prompt: 'Decide if this company is a good fit for us.\n\nA good fit: [describe your ideal customer, for '
        + 'example "B2B software companies with 50 to 500 employees"].\n\n'
        + `${company}\n\nAnswer with only YES or NO.`,
    },
    {
      id: 'classify', label: 'Classify', hint: 'Puts each row into one of the categories you list',
      columnName: freeName('Category', taken), outputColumns: [],
      prompt: 'Put this company into exactly one of these categories: [Category A], [Category B], [Category C], '
        + `Other.\n\n${company}\n\nAnswer with only the category name, written exactly as above.`,
    },
    {
      id: 'opener', label: 'Write an opener', hint: 'The first line of a cold email, from the row\'s details',
      columnName: freeName('Opener', taken), outputColumns: [],
      prompt: `Write the first line of a cold email to ${who}.\n\n${person}\n\nMention one specific thing about `
        + 'them or their company from these details. Keep it under 25 words, friendly and plain. No greeting, no '
        + 'exclamation marks, and don\'t make anything up.',
    },
    {
      id: 'score', label: 'Lead score 1-10', hint: 'A number from 1 (poor fit) to 10 (perfect fit)',
      columnName: freeName('Lead score', taken), outputColumns: [],
      prompt: 'Score how well this lead fits our ideal customer, from 1 (poor fit) to 10 (perfect fit).\n\n'
        + 'Our ideal customer: [describe them, for example "heads of sales at B2B software companies with 50 to '
        + `500 employees"].\n\n${person}\n\nAnswer with only the number.`,
    },
    {
      id: 'profile', label: 'Company profile', hint: 'Industry, size, head office, founding year and more, '
        + 'each in its own column',
      columnName: freeName('Company profile', taken),
      outputColumns: PROFILE_COLUMNS.map(c => ({ ...c, columnName: freeName(c.columnName, taken) })),
      prompt: `Describe this company from what you know about it.\n\n${company}\n\nIf you aren't sure of a `
        + 'value, leave it empty instead of guessing.',
    },
  ]
}
