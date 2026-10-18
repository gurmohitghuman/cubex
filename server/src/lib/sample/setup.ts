// What the sample sheet is made of besides its rows (services/sample-table.ts):
// its names, the free columns filled for it, the AI column set up for it, and
// the words that describe each. Every value here is shown to people or agents.
export const SAMPLE_TABLE_NAME = 'Sample leads';
export const SAMPLE_SHEET_NAME = 'Leads';

export const SAMPLE_SHEET_DESCRIPTION =
  'Sample data to try Cubex: 25 made-up leads. Every name, company, website and email is invented, and the '
  + 'websites and emails end in .example, an ending kept for examples, so no row points at a real person or company. '
  + 'Delete the table when you are done: it goes to the trash like any table.';

// A clean data column: free, no AI (lib/clean/).
export const SAMPLE_CLEAN = { source: 'Company', cleaner: 'company_name', column: 'Company (clean)' } as const;

// A formula column: free, no AI (lib/formula/).
export const SAMPLE_FORMULA = {
  column: 'Seniority',
  formula: '/\\b(ceo|chief|founder|owner|partner|vp|head|director)\\b/i.test({{Title}}) ? "Leader"'
    + ' : /\\b(manager|lead)\\b/i.test({{Title}}) ? "Manager" : "Individual"',
  description: 'Leader, Manager or Individual from the words in the title',
} as const;

// The duplicate the rows hold on purpose: Priya Raman, twice, her email written differently.
export const SAMPLE_DEDUPE_COLUMNS = [{ column: 'Email', match: 'email' }];

// The AI column: set up, never run by Cubex. A run of "Good fit" writes "Good fit (Output)".
export const SAMPLE_AI_NAME = 'Good fit';
export const SAMPLE_AI_COLUMN = `${SAMPLE_AI_NAME} (Output)`;
export const SAMPLE_AI_PROMPT = [
  'We sell route-planning software to companies whose vans, trucks or field crews go out every day '
    + '(deliveries, moving, repairs, home visits).',
  '',
  'Company: /Company',
  "Person's title: /Title",
  '',
  'Is this lead a good fit? Answer with only YES or NO.',
].join('\n');
export const SAMPLE_AI_TRY_ROWS = 5;

// The order the sheet shows: each free column beside the one it reads, the AI
// column after what it reads (in view at 1280px wide), the website last.
export const SAMPLE_COLUMN_ORDER = [
  'Name', 'Company', SAMPLE_CLEAN.column, 'Title', SAMPLE_FORMULA.column, SAMPLE_AI_COLUMN, 'Email', 'Website',
];

export const SAMPLE_COLUMN_DESCRIPTIONS: Record<string, string> = {
  Name: 'Made-up names. A few have extra spaces or odd capitals on purpose, as real lists do.',
  Company: 'Made-up companies, some written messily on purpose: capitals, spaces, Inc. or LLC.',
  Website: 'Made-up websites ending in .example, an ending kept for examples, so none of them is a real site.',
  Email: 'Made-up emails. Priya Raman is listed twice with her email written differently (rows 3 and 18), '
    + 'and Yara Haddad has no email.',
  Title: 'Job titles, some in lower case.',
  [SAMPLE_CLEAN.column]: 'A clean data column: the company names tidied (capitals, spaces, and endings like '
    + 'Inc. and LLC dropped). Free: no AI, and nothing is sent anywhere. New rows are cleaned by themselves.',
  [SAMPLE_FORMULA.column]: 'A formula column: Leader, Manager or Individual, worked out from each title by a '
    + 'small JavaScript formula. Free: no AI.',
  [SAMPLE_AI_COLUMN]: 'An AI column: your AI model reads each company and title and answers YES or NO. Cubex '
    + 'set it up without running it, because it uses your OpenRouter key and costs a little per row. Click '
    + `AI Column above the grid to see the prompt, pick your model and try it on ${SAMPLE_AI_TRY_ROWS} rows first.`,
};
