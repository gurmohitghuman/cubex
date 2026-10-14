import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CLEANERS, PHONE_FORMATS } from '../lib/clean/cleaners';
import { agentCleanColumn } from '../services/clean-agent';
import { McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean } from './tool-helpers';

// clean_column: free data cleaning into a new column (services/clean-agent.ts).
export function registerCleanTool(server: McpServer, ctx: McpAuthCtx): void {
  registerTool(server, 'clean_column', {
    description:
      'Clean a column into a new column for FREE: no AI, no credits, no requests, nothing leaves Cubex. Prefer it '
      + 'over run_ai_column for any cleanup it covers. cleaner: person_name (fixes words typed in ALL CAPS or '
      + 'lowercase, "John SMITH" too, keeping DeShawn and McDonald; turns "Smith, John" around; drops Mr/Dr/Jr/PhD '
      + 'and nicknames), first_name, last_name (keeps "van", "de la"), '
      + 'company_name (drops Inc, LLC, Corp, Ltd, GmbH and other legal endings and a trailing ", a company of X"; '
      + 'fixes ALL CAPS), email (lowercase; blank when the format is invalid, which says nothing about delivery), '
      + 'domain (the root domain of a website or an email: "https://blog.acme.co.uk/x" and "pat@acme.co.uk" give '
      + '"acme.co.uk"), phone (phone_country, default US, is how bare digits are read; phone_format national '
      + '"(212) 555-0123" (default; a number from another country comes out international), international '
      + '"+1 212 555 0123" or e164 "+12125550123"; blank when not a real number), title_case (keeps small words and '
      + 'acronyms: "VP of Sales"), lowercase, trim (also collapses inner spaces and line breaks and removes invisible '
      + 'characters). Writes into column (default "<source_column> (clean)", or "(first name)", "(last name)", '
      + '"(domain)"), always a new column: naming a clean column already there replaces its setup with this call\'s '
      + 'and cleans every row again; any other existing column is refused. auto_run (default true for a new column) '
      + 'keeps it following its source: new rows, and rows whose source changes, are cleaned again on their own. '
      + 'preview:true shows the first rows before and after and writes nothing. Waits for the fill up to 10 seconds '
      + 'and returns cleaned_rows and blank_rows (values the cleaner could not read); a bigger sheet returns status '
      + '"filling".',
    inputSchema: z.object({
      sheet_id: z.string(),
      source_column: z.string().describe('The column to clean'),
      cleaner: z.enum(CLEANERS),
      column: z.string().optional().describe('The clean column to write; created if it does not exist'),
      phone_format: z.enum(PHONE_FORMATS).optional().describe('phone only: national (default), international or e164'),
      phone_country: z.string().length(2).optional()
        .describe('phone only: how bare digits are read, e.g. US (default)'),
      auto_run: lenientBoolean().optional(),
      preview: lenientBoolean().optional(),
    }).strict(),
  }, async ({ sheet_id, ...a }) => {
    const denied = missingScope(ctx, 'write');
    if (denied) return denied;
    const out = await agentCleanColumn(ctx.userId, sheet_id, a);
    return 'ok' in out ? ok(out.ok) : err(out.message);
  });
}
