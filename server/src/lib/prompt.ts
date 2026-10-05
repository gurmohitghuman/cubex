// Helpers for processing AI prompts that reference sheet columns via /column tokens.

// Convert a human column name like "Website URL" → "website_url" for /token matching.
export function normalizeColumnName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
}

// Token pattern shared by extractColumnReferences and processPromptTemplate.
// The (?<![/:\w]) lookbehind skips slashes that are part of surrounding text —
// URLs (https://x.com/path, www.x.com/path), fractions ("24/7"), dates
// ("01/02/2026") — so only genuine /column references match. MUST stay in
// sync with the /token branch of the parser regex in lib/http-request-template.ts.
export const COLUMN_REF_PATTERN = /(?<![/:\w])\/([a-zA-Z0-9_-]+)/g;

// Pull all unique /token reference names from a prompt (no leading slash).
export function extractColumnReferences(prompt: string): string[] {
  const refs = new Set<string>();
  for (const m of prompt.matchAll(COLUMN_REF_PATTERN)) refs.add(m[1]);
  return [...refs];
}

// Resolve every /token in a prompt against the sheet's REAL columns using the
// same matching rule as processPromptTemplate (normalized or case-insensitive
// exact), returning the tokens that would substitute as "[MISSING: ...]" on
// every row at run time. Used to REJECT a run/preview up front: a burned run
// once produced 961 paid garbage rows because "/Company Fit (Output)" typed
// literally matches only "/Company" (the token regex stops at the space).
// Each unknown ref carries a suggestion when a real column's normalized name
// extends the token — exactly that literal-name case.
export function findUnknownColumnReferences(
  prompt: string,
  columns: string[],
): Array<{ ref: string; suggestion?: string }> {
  const unknown: Array<{ ref: string; suggestion?: string }> = [];
  for (const ref of extractColumnReferences(prompt)) {
    const matched = columns.some(col =>
      normalizeColumnName(col) === ref || col.toLowerCase() === ref.toLowerCase());
    if (matched) continue;
    const refNorm = normalizeColumnName(ref);
    const candidate = refNorm
      ? columns.find(col => normalizeColumnName(col).startsWith(refNorm))
      : undefined;
    unknown.push(candidate ? { ref, suggestion: normalizeColumnName(candidate) } : { ref });
  }
  return unknown;
}

// One-line human/agent-facing message for the unknown refs above.
export function unknownRefsMessage(unknown: Array<{ ref: string; suggestion?: string }>): string {
  const parts = unknown.map(u =>
    u.suggestion ? `/${u.ref} (did you mean /${u.suggestion}?)` : `/${u.ref}`);
  return `Unknown column${unknown.length > 1 ? 's' : ''}: ${parts.join(', ')}. ` +
    'Write a column as / and its name in lowercase with underscores ("Company Name" is /company_name); ' +
    'for a plain slash, put a space after it.';
}

// Substitute /column tokens in a prompt with this row's actual cell values.
// Falls back to "[MISSING: /tokenName]" when a referenced column isn't in the row.
//
// Single-pass callback replacement, deliberately: each occurrence is judged at
// its own position (the same token can be a real reference in one spot and part
// of a URL elsewhere in the prompt), and the callback's return value is taken
// literally — so cell values containing $&, $', $$ etc. can't be expanded as
// replacement patterns by String.replace.
export function processPromptTemplate(prompt: string, rowData: Record<string, string>): string {
  return prompt.replace(COLUMN_REF_PATTERN, (token, columnRef: string) => {
    const matchingColumn = Object.keys(rowData).find(col =>
      normalizeColumnName(col) === columnRef || col.toLowerCase() === columnRef.toLowerCase()
    );
    if (matchingColumn) return rowData[matchingColumn] || '';
    return `[MISSING: ${token}]`;
  });
}

// Pull unique hostnames from URL-valued cells of columns the prompt references.
// Used to populate `allowed_domains` on the OpenRouter web_fetch tool so the
// model can ONLY fetch URLs the user actually pointed at via /column tokens.
//
// Per-row: each row's URL columns may resolve to different hosts, so we run
// this per-row inside the runner rather than once at run-start.
export function extractAllowedDomainsFromRow(
  prompt: string,
  rowData: Record<string, string>,
): string[] {
  const refs = extractColumnReferences(prompt);
  const hosts = new Set<string>();

  for (const ref of refs) {
    const matchingColumn = Object.keys(rowData).find(col =>
      normalizeColumnName(col) === ref || col.toLowerCase() === ref.toLowerCase()
    );
    if (!matchingColumn) continue;

    const value = (rowData[matchingColumn] || '').trim();
    if (!value) continue;

    // Accept "example.com/path", "https://example.com", "www.example.com".
    // URL constructor needs a protocol; prepend https:// when absent.
    const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(candidate);
      const host = u.hostname.replace(/^www\./, '').toLowerCase();
      // Filter out obviously-wrong hosts (no dot, IPs, localhost) so a cell
      // value that happens to start with letters but isn't a real URL doesn't
      // become an allowed domain.
      if (host.includes('.') && !host.endsWith('.local') && host !== 'localhost') {
        hosts.add(host);
      }
    } catch {
      // Not a parseable URL; skip silently.
    }
  }

  return Array.from(hosts);
}
