// Unit test for lib/ai-prompt-inputs.ts — does a prompt READ this column?
//
// The matching rule must mirror processPromptTemplate EXACTLY. Too strict and
// we block harmless renames; too loose and a renamed source column silently
// turns every remaining row into "[MISSING: /old_name]" — the bug this guards.
// So the cases below are mostly about the token grammar (lib/prompt.ts
// COLUMN_REF_PATTERN) rather than the happy path.
// server/src is type:commonjs → default-import + destructure under tsx.
import promptInputs from '../../server/src/lib/ai-prompt-inputs'
const { promptReferencesColumn } =
  promptInputs as typeof import('../../server/src/lib/ai-prompt-inputs')

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}
const reads = (prompt: string, col: string) => promptReferencesColumn(prompt, col)

// --- the normalized match (how /tokens actually resolve) ---------------------
check('exact token', reads('Summarize /company', 'company'))
check('spaces normalize to underscore', reads('Check /website_url now', 'Website URL'))
check('case-insensitive', reads('Look at /COMPANY', 'company'))
check('punctuation normalizes', reads('Use /b2b_saas', 'B2B (SaaS)'))
check('AI output column as an input', reads('Rate /score_output', 'Score (Output)'))
check('hyphen in token', reads('Use /first-name', 'first-name'))

// --- non-matches: renaming these must stay allowed ---------------------------
check('unrelated column', !reads('Summarize /company', 'revenue'))
check('token is a PREFIX of the column, not a match',
  !reads('Use /comp', 'Company Fit'))
// The shape of a real incident: "/Company Fit (Output)" typed literally only
// ever tokenizes as "/Company". The column "Company Fit" does NOT match that
// token, which is exactly why the run produced [MISSING] on every row. The
// guard must agree with that reality, not with intent.
check('incident shape: /Company does not match "Company Fit"',
  !reads('Score /Company Fit (Output) for fit', 'Company Fit'))
check('...but DOES match the column actually named Company',
  reads('Score /Company Fit (Output) for fit', 'Company'))

// --- the token grammar: things that LOOK like refs but are not ---------------
// COLUMN_REF_PATTERN's (?<![/:\w]) lookbehind excludes these on purpose.
check('URL path is not a ref', !reads('See https://x.com/company for detail', 'company'))
check('protocol-relative URL is not a ref', !reads('Visit //cdn.x.com/company', 'company'))
check('fraction is not a ref', !reads('Open 24/7 support', '7'))
check('date is not a ref', !reads('Dated 01/02/2026', '02'))
check('mid-word slash is not a ref', !reads('either/or choice', 'or'))

// --- empty / degenerate ------------------------------------------------------
check('empty prompt reads nothing', !reads('', 'company'))
check('prompt with no tokens', !reads('Just plain prose here.', 'company'))
check('empty column name is not matched by a real token',
  !reads('Summarize /company', ''))

// --- multiple refs -----------------------------------------------------------
const multi = 'Compare /company against /competitor using /revenue'
check('finds first of several', reads(multi, 'company'))
check('finds middle of several', reads(multi, 'competitor'))
check('finds last of several', reads(multi, 'revenue'))
check('rejects an absent one', !reads(multi, 'industry'))

console.log(failures === 0 ? '\nAll prompt-input tests passed' : `\n${failures} FAILURES`)
if (failures > 0) process.exit(1)
