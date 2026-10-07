// Cleaning cell values before they go to treg (pure). Better hit rates, and
// rows that mean the same company send the same request (one call per run).

// Inputs that take a bare domain. "Clean up to a domain" is on by default for them.
export const DOMAIN_INPUT_NAMES = new Set(['domain', 'company_domain', 'website', 'company_website', 'url_domain']);

// "https://www.Stripe.com/about?x=1" → "stripe.com"; "pat@stripe.com" → "stripe.com".
export function cleanDomain(value: string): string {
  let v = value.trim().toLowerCase();
  if (!v) return v;
  const at = v.lastIndexOf('@');
  if (at !== -1 && !v.includes('/')) v = v.slice(at + 1);
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  v = v.split(/[/?#]/)[0];
  v = v.replace(/:\d+$/, '').replace(/\.$/, '');
  if (v.startsWith('www.')) v = v.slice(4);
  return v;
}

// For the email guess: "José María" → "josemaria"; keeps letters, digits and hyphens.
export function asciiNamePart(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9-]/g, '');
}
