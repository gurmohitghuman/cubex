// Name safety: sheet, table and column names are shown to people AND handed
// to agents, so a name must look like what it is. Cell values are handled in
// csv-safety.ts.

// Characters that render as nothing yet make two names differ. Two names that
// look the same must BE the same name ("QA" and "QA" + U+200B could sit side
// by side), and agents read what people can't see (tag characters spell out
// hidden ASCII). The set is Unicode's own: Default_Ignorable_Code_Point (zero
// width characters, variation selectors, tags, fillers, bidi controls), the
// format characters (Cf) and the control characters, plus braille blank.
// Whitespace controls (tab, newline) aren't in it: names collapse those to a
// space (normalizeNameSpacing, sanitizeColumnName).
const HIDDEN = /[\p{Default_Ignorable_Code_Point}\p{Cf}\u0000-\u0008\u000E-\u001F\u007F-\u009F\u2800]/u;

const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const EMOJI_MODIFIER = /\p{Emoji_Modifier}/u;
const EMOJI = /\p{Emoji}/u;
const KEYCAP_BASE = /[0-9#*]/;
// Scripts where a zero-width joiner or non-joiner changes how letters join, so
// between two of their letters it is visible spelling (Persian plurals, Hindi
// half forms), not a hidden mark.
const JOINING_LETTER = /(?=[\p{L}\p{M}])[\p{scx=Arab}\p{scx=Syrc}\p{scx=Nkoo}\p{scx=Mong}\p{scx=Deva}\p{scx=Beng}\p{scx=Guru}\p{scx=Gujr}\p{scx=Orya}\p{scx=Taml}\p{scx=Telu}\p{scx=Knda}\p{scx=Mlym}\p{scx=Sinh}]/u;
const is = (re: RegExp, code: number | undefined) => code !== undefined && re.test(String.fromCodePoint(code));
// The only emoji built from tag characters: U+1F3F4 + "gb" + eng/sct/wls + cancel tag.
const TAG_FLAG = /\u{1F3F4}\u{E0067}\u{E0062}(?:\u{E0065}\u{E006E}\u{E0067}|\u{E0073}\u{E0063}\u{E0074}|\u{E0077}\u{E006C}\u{E0073})\u{E007F}/gu;

// Whether the character at i is hidden here. Three have a real use and are
// judged in context: ZWJ inside an emoji, ZWJ/ZWNJ between letters of a
// joining script, and the emoji presentation selectors after an emoji.
function hiddenAt(cps: number[], i: number): boolean {
  const code = cps[i];
  const prev = cps[i - 1];
  const next = cps[i + 1];
  if (code === 0x200C || code === 0x200D) {
    if (is(JOINING_LETTER, prev) && is(JOINING_LETTER, next)) return false;
    if (code === 0x200C) return true;
    // Joins two emoji (man + laptop, white flag + rainbow, a skin-toned person +
    // rocket); a selector before it counts only if it is itself kept.
    const emojiBefore = is(EXTENDED_PICTOGRAPHIC, prev) || is(EMOJI_MODIFIER, prev)
      || (prev === 0xFE0F && !hiddenAt(cps, i - 1));
    return !(emojiBefore && is(EXTENDED_PICTOGRAPHIC, next));
  }
  if (code === 0xFE0E || code === 0xFE0F) {
    // Text/emoji presentation of the emoji before it (a red heart). A keycap is
    // digit + FE0F + U+20E3; a bare digit + FE0F just looks like the digit.
    if (is(KEYCAP_BASE, prev)) return next !== 0x20E3;
    return !is(EMOJI, prev);
  }
  return HIDDEN.test(String.fromCodePoint(code));
}

// One pass for both helpers: the name without its hidden characters, and
// whether it had any. The three tag flags are kept whole. Stripping is a fixed
// point: everything a kept character relies on in context is itself kept.
function scanName(s: string): { visible: string; found: boolean } {
  let visible = '';
  let found = false;
  const scan = (part: string) => {
    const cps = [...part].map(ch => ch.codePointAt(0)!);
    cps.forEach((code, i) => {
      if (hiddenAt(cps, i)) found = true;
      else visible += String.fromCodePoint(code);
    });
  };
  let last = 0;
  for (const m of s.matchAll(TAG_FLAG)) {
    scan(s.slice(last, m.index));
    visible += m[0];
    last = m.index! + m[0].length;
  }
  scan(s.slice(last));
  return { visible, found };
}
export const stripInvisibleNameChars = (s: string): string => scanName(s).visible;
export const containsInvisibleNameChar = (s: string): boolean => scanName(s).found;

// The canonical form of a table or sheet name: trimmed, and every run of
// whitespace (tabs, newlines, no-break and other Unicode spaces, doubled
// spaces) made one plain space, so "QA B" and "QA  B" can't sit side by side
// looking the same. Column names get the same rule in sanitizeColumnName.
export const normalizeNameSpacing = (s: string): string => s.trim().replace(/\s+/g, ' ');
