// The text the person name and company cleaners read (pure): spaces tidied
// (cleanTrim), emoji dropped, full-width letters read as plain ones, and
// whether a whole value is a placeholder ("n/a", "unknown") rather than a name.
import { MAX_CLEAN_FIELD_CHARS } from '../constants-clean';
import { PERSON_NAME_EXCEPTIONS, PLACEHOLDER_NAME_EXCEPTIONS, PLACEHOLDERS } from './name-words';
import { cleanTrim } from './text';

// Enclosed letters (Ⓜ, 🅰): letters here, dropped only as emoji (with U+FE0F after them).
const ENCLOSED_LETTER = String.raw`[\u24B6-\u24E9\u{1F130}-\u{1F189}]`;
// One emoji part: a pictograph (© ® ™ too) other than an enclosed letter, a
// skin tone, half a flag, a tag of a subdivision flag, a presentation
// selector, or a whole keycap (a digit, U+FE0F, U+20E3). A digit, # or * on
// its own stays, and so does ℠ (not a pictograph).
const PART = String.raw`[0-9#*]\uFE0F?\u20E3|${ENCLOSED_LETTER}\uFE0F|(?!${ENCLOSED_LETTER})\p{Extended_Pictographic}`
  + String.raw`|[\p{Emoji_Modifier}\p{Regional_Indicator}\u{E0020}-\u{E007F}\uFE0E\uFE0F\u20E3]`;
// A run of parts and the zero-width joiners between them (a family, a rainbow
// flag). A joiner between letters of a joining script isn't next to one.
const EMOJI_RUN = new RegExp(`(?:${PART})(?:\\u200D?(?:${PART}))*`, 'gu');

const dropEmoji = (s: string): string => s.replace(EMOJI_RUN, ' ');

// Only full-width ASCII (U+FF01-U+FF5E, "Ｍｉｃｈａｅｌ") becomes plain ASCII, and the
// ideographic space a space. Everything else stays exactly as typed: "Mª",
// "№1", "Ⅷ", "E²", "℠", ligatures ("ﬁ"), half-width kana, and Thai.
const FULL_WIDTH = /[\uFF01-\uFF5E\u3000]/g;
const FULL_WIDTH_OFFSET = 0xFEE0;
const foldFullWidth = (s: string): string => s.replace(FULL_WIDTH, ch =>
  (ch === '\u3000' ? ' ' : String.fromCharCode(ch.charCodeAt(0) - FULL_WIDTH_OFFSET)));

// The value as the cleaners read it. A value longer than MAX_CLEAN_FIELD_CHARS
// comes back only tidied: the cleaners read it as no name.
export function nameText(value: string): string {
  const s = cleanTrim(value);
  if (!s || s.length > MAX_CLEAN_FIELD_CHARS) return s;
  return cleanTrim(dropEmoji(foldFullWidth(dropEmoji(s))));
}

const EDGES = /^[\s.()[\]{}]+|[\s.()[\]{}]+$/gu;

// A placeholder (name-words.ts), not a name. "Nil", "Null" and "Blank" written
// so are names; personName: "Na" too.
export function isPlaceholder(s: string, personName: boolean): boolean {
  const core = s.replace(EDGES, '');
  if (PLACEHOLDER_NAME_EXCEPTIONS.has(core) || (personName && PERSON_NAME_EXCEPTIONS.has(core))) return false;
  return PLACEHOLDERS.has(core.toLowerCase());
}
