// Template tokens (pure, no DB): the regex every template reader shares, so
// the scan and substitution never drift (lib/http-request-template.ts
// re-exports both). Split out so pure modules can read tokens without the
// saved-key lookup the substitution needs.

// The two accepted template token forms:
//   /column_name    — AI column / API-key convention. Allows word chars AND
//                     hyphens, because both API_KEY_NAME_PATTERN and
//                     COLUMN_NAME_PATTERN permit hyphens — a key like
//                     `apollo-key` is suggested as `/apollo-key`. The lookbehind
//                     excludes "://" and trailing-word chars so URLs like
//                     https://x.com/foo-bar aren't mistaken for refs. Matches the
//                     hyphen-inclusive class already used by extractColumnReferences.
//   {{column_name}} — explicit double-brace. Same name resolution.
// We deliberately do NOT support single-brace {column}. ONE regex governs both
// live substitution below and the PAT 'secrets'-scope scan (http-secrets-scan.ts)
// — two copies would drift and open a scan bypass. matchAll clones the regex, so
// the shared /g instance is safe. The name excludes { as well as }: with [^}]
// a long run of "{" made every match attempt scan to the end of the text, so a
// big body took seconds to minutes (quadratic). A name with a { can't be a {{ref}}.
export const TEMPLATE_TOKEN_RE = /\{\{([^{}]+)\}\}|(?<![/:\w])\/([a-zA-Z0-9_-]+)/g;

// Every token NAME a template references ({{name}} → trimmed inner, /name →
// bare name). Used by the run-start secrets scan.
export function extractTemplateTokenNames(template: string): string[] {
  if (typeof template !== 'string') return [];
  const names: string[] = [];
  for (const m of template.matchAll(TEMPLATE_TOKEN_RE)) {
    const name = m[1] !== undefined ? m[1].trim() : m[2];
    if (name) names.push(name);
  }
  return names;
}
