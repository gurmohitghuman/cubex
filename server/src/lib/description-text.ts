// A sheet's or a column's description as given (pure): text, cleaned the way
// names are (lib/name-safety.ts), because people and agents both read it:
// control and bidi characters go (csv-safety.ts), and so do the characters
// that render as nothing (tag characters can spell out words only an agent
// sees). Line breaks stay, at most one blank line in a row. Empty clears it.
import { stripControlChars } from './csv-safety';
import { stripInvisibleNameChars } from './name-safety';

export function cleanDescription(raw: unknown, max: number): { text: string | null } | { error: string } {
  if (raw === undefined || raw === null) return { text: null };
  if (typeof raw !== 'string') return { error: 'description must be text.' };
  const tooLong = { error: `A description can be at most ${max.toLocaleString('en-US')} characters.` };
  // Far too long even with hidden characters to strip: refused before the cleaning pass reads it.
  if (raw.length > max * 4) return tooLong;
  const lines = stripControlChars(raw.replace(/\r\n?/g, '\n').replace(/\t/g, ' '))
    .split('\n').map(line => stripInvisibleNameChars(line).trimEnd());
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if ([...text].length > max) return tooLong;
  return { text: text || null };
}
