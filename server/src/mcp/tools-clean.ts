import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { CLEANERS, NAME_INPUTS, PHONE_FORMATS, THE_COMPANY } from '../lib/clean/cleaners';
import { agentCleanColumn } from '../services/clean-agent';
import { SHEET_ID, McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean } from './tool-helpers';
import { fillChanged } from './changed';

// clean_column: free data cleaning into a new column (services/clean-agent.ts).
export function registerCleanTool(server: McpServer, ctx: McpAuthCtx): void {
  registerTool(server, 'clean_column', {
    description:
      'Clean a column into a new column for FREE: no AI, no credits, no requests, nothing leaves Cubex. Prefer it '
      + 'over run_ai_column for any cleanup it covers, and over transform_column for names, companies, emails, '
      + 'domains and phones. The name and company cleaners drop emoji, read full-width characters as plain ones, '
      + 'and leave a placeholder cell (n/a, none, null, unknown, test, -) blank. Writes into column (default '
      + '"<source_column> (clean)", or "(first name)", "(last name)", "(domain)"), always a new column: naming a '
      + 'clean column already there replaces its setup and cleans every row again; any other existing column is '
      + 'refused. Waits for the fill up to 10 seconds and returns cleaned_rows and blank_rows (values the cleaner '
      + 'could not read); a bigger sheet returns status "filling". Next: read_rows to check it.',
    inputSchema: z.object({
      sheet_id: z.string().describe(SHEET_ID),
      source_column: z.string().describe('The column to clean'),
      cleaner: z.enum(CLEANERS).describe(
        'person_name (fixes ALL CAPS or lowercase, keeping DeShawn and McDonald; turns "Smith, John" around; drops '
        + 'Mr/Dr/Jr/PhD and nicknames), first_name ("J. Michael Fox" gives "Michael"; never the last name), '
        + 'last_name (keeps "van", "de la"), company_name (drops Inc, LLC, GmbH and other legal endings, ", a '
        + 'company of X" and stray brackets; fixes ALL CAPS), email (lowercase; blank when the format is invalid, '
        + 'which says nothing about delivery), domain (the root domain of a website or email: '
        + '"https://blog.acme.co.uk/x" gives "acme.co.uk"), phone (blank when not a real number), title_case (keeps '
        + 'small words and acronyms: "VP of Sales"), lowercase, trim (also inner spaces, line breaks and invisible '
        + 'characters), fix_encoding (repairs UTF-8 read as Windows-1252 or Latin-1: "CafÃ©" gives "Café"; what it '
        + 'can\'t repair stays as it was)'),
      column: z.string().optional().describe('The clean column to write; created if it does not exist'),
      phone_format: z.enum(PHONE_FORMATS).optional().describe('phone only: national (default), international or e164'),
      phone_country: z.string().length(2).optional()
        .describe('phone only: how bare digits are read, e.g. US (default)'),
      name_input: z.enum(NAME_INPUTS).optional()
        .describe('first_name and last_name only: what the column holds. full_name (default): whole names; '
          + 'first_name: first names only ("Dr. Sarah" gives "Sarah"); last_name: last names only'),
      the_company: z.enum(THE_COMPANY).optional()
        .describe('company_name only: strip (default) turns "The Christman Company" into "Christman"; keep keeps '
          + 'it whole. Other legal endings go either way'),
      auto_run: lenientBoolean().optional()
        .describe('Default true for a new column: new rows, and rows whose source changes, are cleaned on their own'),
      preview: lenientBoolean().optional().describe('true: show the first rows before and after; write nothing'),
    }).strict(),
  }, async ({ sheet_id, ...a }) => {
    const denied = missingScope(ctx, 'write');
    if (denied) return denied;
    const out = await agentCleanColumn(ctx.userId, sheet_id, a);
    return 'ok' in out ? ok({ ...out.ok, changed: fillChanged(ctx.userId, sheet_id, out.ok) }) : err(out.message);
  });
}
