// Characters the JSON tree never shows as they are (pure), shared by what it
// displays (tree-model.ts visibleText) and the paths it builds (jsonPath.ts):
// the ones that change how text around them looks or can't be seen. C0/C1
// controls, soft hyphen, combining grapheme joiner, Hangul fillers, Khmer
// invisible vowels, Mongolian selectors and vowel separator, zero-width space,
// bidi marks, embeddings, overrides and isolates, line/paragraph separators,
// word joiners and invisible operators, braille blank, the BOM, interlinear
// annotation marks; above the BMP, musical formatting and the tag characters.
// ZWJ/ZWNJ stay (emoji, scripts); so does a single variation selector.
export function isHiddenBmp(c: number): boolean {
  return c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0xad || c === 0x034f || c === 0x061c
    || c === 0x115f || c === 0x1160 || c === 0x17b4 || c === 0x17b5 || (c >= 0x180b && c <= 0x180f)
    || c === 0x200b || c === 0x200e || c === 0x200f || (c >= 0x2028 && c <= 0x202e)
    || (c >= 0x2060 && c <= 0x206f) || c === 0x2800 || c === 0x3164 || c === 0xfeff || c === 0xffa0
    || (c >= 0xfff9 && c <= 0xfffb)
}

export function isHiddenAstral(cp: number): boolean {
  return (cp >= 0x1d173 && cp <= 0x1d17a) || (cp >= 0xe0000 && cp <= 0xe007f)
}

// A mark that stacks on the character before it (nonspacing or enclosing). A
// run of more than MARKS_KEPT shows as escapes, so a flood can't paint over
// the rows around it; up to three stacked marks are ordinary text (Vietnamese,
// Hebrew with cantillation, Tibetan).
const STACKING = /[\p{Mn}\p{Me}]/u
export const MARKS_KEPT = 3
export function isStackingMark(cp: number): boolean {
  return cp >= 0x0300 && STACKING.test(String.fromCodePoint(cp))
}

const hex4 = (c: number) => c.toString(16).toUpperCase().padStart(4, '0')
export const BS = String.fromCharCode(92)
// One UTF-16 unit the way JSON escapes it.
export const unitEscape = (c: number): string => BS + 'u' + hex4(c)

// The code point at i and how many units it takes; a lone surrogate is itself.
export function codePointAt(s: string, i: number): { cp: number; width: number; lone: boolean } {
  const c = s.charCodeAt(i)
  if (c >= 0xd800 && c <= 0xdbff) {
    const lo = s.charCodeAt(i + 1) // NaN past the end
    if (lo >= 0xdc00 && lo <= 0xdfff) {
      return { cp: ((c - 0xd800) << 10) + (lo - 0xdc00) + 0x10000, width: 2, lone: false }
    }
    return { cp: c, width: 1, lone: true }
  }
  return { cp: c, width: 1, lone: c >= 0xdc00 && c <= 0xdfff }
}

// Where a subdivision flag's tags end (England, Scotland, Wales: the black flag,
// one to six tag letters or digits, then the cancel tag), or -1: that sequence
// shows as the flag, any other tag character as an escape.
export function flagTagsEnd(s: string, from: number): number {
  let i = from
  for (let n = 0; n <= 6; n++) {
    const { cp, width } = codePointAt(s, i)
    if (cp === 0xe007f) return n > 0 ? i + width : -1
    if (!((cp >= 0xe0030 && cp <= 0xe0039) || (cp >= 0xe0061 && cp <= 0xe007a))) return -1
    i += width
  }
  return -1
}
