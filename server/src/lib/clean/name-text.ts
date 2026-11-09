// The text the person name and company cleaners read (pure): spaces tidied
// (cleanTrim), emoji dropped, compatibility forms folded (NFKC: full-width
// letters, ligatures), and whether a whole value is a placeholder ("n/a",
// "unknown") rather than a name.
import { MAX_CLEAN_FIELD_CHARS } from '../constants-clean';
import { PLACEHOLDER_NAME_EXCEPTION, PLACEHOLDERS } from './name-words';
import { cleanTrim } from './text';

// One emoji part: a pictograph (© ® ™ too), a skin tone, half a flag, a tag of
// a subdivision flag, a presentation selector, or a whole keycap ("1️⃣"). A
// digit, # or * on its own stays.
const PART = String.raw`[0-9#*]️?⃣|[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}`
  + String.raw`\u{E0020}-\u{E007F}︎️⃣]`;
// A run of parts and the zero-width joiners between them (a family, a rainbow
// flag). A joiner between letters of a joining script isn't next to one.
const EMOJI_RUN = new RegExp(`(?:${PART})(?:\\u200D?(?:${PART}))*`, 'gu');

const dropEmoji = (s: string): string => s.replace(EMOJI_RUN, ' ');

// NFKC, character by character, except a character it would turn into a space
// and a mark: "O´Brien" keeps its acute accent rather than becoming "O ́Brien".
// Composing the whole afterwards makes the rest exactly NFKC.
function foldCompat(s: string): string {
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  let out = '';
  for (const ch of s) {
    const folded = ch.normalize('NFKC');
    out += folded.includes(' ') ? ch : folded;
  }
  return out.normalize('NFC');
}

// The value as the cleaners read it. Emoji go before NFKC, which would turn ™
// into TM. A value longer than MAX_CLEAN_FIELD_CHARS comes back only tidied:
// the cleaners read it as no name.
export function nameText(value: string): string {
  const s = cleanTrim(value);
  if (!s || s.length > MAX_CLEAN_FIELD_CHARS) return s;
  return cleanTrim(dropEmoji(foldCompat(dropEmoji(s))));
}

const EDGES = /^[\s.()[\]{}]+|[\s.()[\]{}]+$/gu;

// A placeholder (name-words.ts), not a name. keepNa: "Na" written so is a name.
export function isPlaceholder(s: string, keepNa: boolean): boolean {
  const core = s.replace(EDGES, '');
  if (keepNa && core === PLACEHOLDER_NAME_EXCEPTION) return false;
  return PLACEHOLDERS.has(core.toLowerCase());
}
