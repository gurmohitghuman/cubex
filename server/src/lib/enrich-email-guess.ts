// Verified work email helpers (pure): the free guess (an address worked out from the name and domain)
// and the status cells the loop writes.
import { asciiNamePart, cleanDomain } from './enrich-input-clean';
import type { EmailVerdict } from './enrich-email-status';

export const GUESS_PATTERNS = ['first.last', 'firstlast', 'first', 'flast', 'f.last', 'first_last'] as const;

// The row's name and company domain as the find request sent them.
export function guessParts(sent: Record<string, unknown>): { first: string; last: string; domain: string } | null {
  const str = (k: string) => (typeof sent[k] === 'string' ? (sent[k] as string).trim() : '');
  const words = str('full_name').split(/\s+/).filter(Boolean);
  const first = asciiNamePart(str('first_name') || words[0] || '');
  const last = asciiNamePart(str('last_name') || (words.length > 1 ? words[words.length - 1] : ''));
  const domain = cleanDomain(str('domain') || str('company_domain') || str('website') || str('company_website'));
  if (!first || !last || !domain || !domain.includes('.')) return null;
  return { first, last, domain };
}

export function guessEmail(pattern: string, p: { first: string; last: string; domain: string }): string | null {
  const local: Record<string, string> = {
    'first.last': `${p.first}.${p.last}`, firstlast: `${p.first}${p.last}`, first: p.first,
    flast: `${p.first[0]}${p.last}`, 'f.last': `${p.first[0]}.${p.last}`, first_last: `${p.first}_${p.last}`,
  };
  const l = local[pattern];
  return l ? `${l}@${p.domain}` : null;
}

// ✅ cells for an accepted address, ⏭️ for the best one that wasn't.
export function acceptedCell(verdict: EmailVerdict): string {
  return verdict === 'catch_all' ? '✅ Catch-all' : verdict === 'risky' ? '✅ Risky' : '✅ Valid';
}

export function rejectedCell(verdict: EmailVerdict): string {
  if (verdict === 'catch_all') return '⏭️ Only a catch-all address (not accepted)';
  if (verdict === 'risky') return '⏭️ Only a risky address (not accepted)';
  if (verdict === 'no_verdict') return "⏭️ Couldn't check the address";
  return '⏭️ No valid email found';
}

// Rank for keeping the most useful rejected address to report.
export const VERDICT_RANK: Record<EmailVerdict, number> = { valid: 4, catch_all: 3, risky: 2, no_verdict: 1, invalid: 0 };
