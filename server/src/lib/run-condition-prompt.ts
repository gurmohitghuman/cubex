// Writing an "Only run if" rule from plain words (pure): what the model is
// told and what it's shown. One call writes the rule; Cubex then checks every
// row against it itself, so no row is ever sent to the model. The model sees
// the rule language, the sheet's column names and a few real values from each
// column, so a rule uses the exact words a sheet holds ("Software", not
// "SaaS"; "51-200", not 51).
export const RULE_SYSTEM_PROMPT = `You turn a person's request into a row filter for a spreadsheet.
Reply with the rule only: one line, no explanation, no code fences.

The rule language:
  {{Column}} is "text"          {{Column}} is not "text"
  {{Column}} contains "text"    {{Column}} does not contain "text"
  {{Column}} is empty           {{Column}} is not empty
  {{Column}} > 50   {{Column}} < 50   {{Column}} >= 50   {{Column}} <= 50
Join checks with AND, OR, NOT and brackets. AND binds tighter than OR, so use
brackets when you mix them: ({{A}} is "x" OR {{A}} is "y") AND {{B}} > 10.

How rows are checked:
- Name columns exactly as listed, inside {{ }}.
- Text checks ignore case and outer spaces. Put text in double quotes.
- >, <, >= and <= only work when the cell holds a plain number. A cell like
  "51-200" or "1k" is not a number: use is / contains on such columns instead.
- Cells starting with ⏳, ❌, ⏭️ or ➕ are the app's own status words and count as empty.
- Use the values shown for each column: match their exact spelling.

If the request needs judgment the values can't show (for example "is a good
fit" with no column that says so), or names a column that doesn't exist,
reply with: CANNOT: <one short sentence saying why and what column would help>`;

const MAX_VALUES = 8;
const MAX_VALUE_CHARS = 60;

// Up to a few distinct values a column holds in the given rows (Cubex's own
// status words left out: they read as empty).
export function columnSamples(
  columns: string[], rows: Array<Record<string, string>>, isMarker: (v: string) => boolean,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const c of columns) {
    const seen = new Set<string>();
    for (const r of rows) {
      const v = (r[c] ?? '').toString().trim();
      if (!v || isMarker(v)) continue;
      seen.add(v.length > MAX_VALUE_CHARS ? `${v.slice(0, MAX_VALUE_CHARS)}…` : v);
      if (seen.size >= MAX_VALUES) break;
    }
    out[c] = [...seen];
  }
  return out;
}

export function ruleUserMessage(words: string, samples: Record<string, string[]>, retry?: string): string {
  const lines = Object.entries(samples).map(([c, vs]) =>
    `- {{${c}}}: ${vs.length ? vs.map(v => JSON.stringify(v)).join(', ') : '(empty in the rows shown)'}`);
  return [
    `Request: ${words}`, '', 'Columns, with values from the first rows:', ...lines,
    ...(retry ? ['', `Your last rule was refused: ${retry} Write it again.`] : []),
  ].join('\n');
}

// The model's reply as a rule, or why it couldn't write one.
export function readRuleReply(raw: string): { rule: string } | { cannot: string } {
  const text = raw.replace(/^```[a-z]*\s*|```\s*$/gi, '').trim();
  const cannot = /^CANNOT:\s*(.*)$/is.exec(text);
  if (cannot) return { cannot: cannot[1].trim() || "That can't be written as a rule." };
  const first = text.split('\n').map(l => l.trim()).find(Boolean) ?? '';
  return { rule: first.replace(/^rule:\s*/i, '') };
}
