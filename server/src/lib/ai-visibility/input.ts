// What an AI visibility table is made from, parsed strictly (pure): your
// brand, the other brands to look for, your site's domain, where the questions
// are asked from, the engines to ask and the questions. The same parse serves
// the app, /api/v1 and MCP.
import { stripControlChars } from '../csv-safety';
import { cleanDomain } from '../clean/domain';
import { holdsRunMarker } from '../enrich-seed';
import { FORMULA_MAX_CHARS } from '../constants-formula';
import {
  AI_VISIBILITY_MAX_BRAND_CHARS, AI_VISIBILITY_MAX_COMPETITORS, AI_VISIBILITY_MAX_QUESTION_CHARS,
  AI_VISIBILITY_MAX_QUESTIONS,
} from '../constants';
import { ENGINES, engineColumns, engineById, type EngineId } from './engines';
import { namedFirstFormula, youFormula } from './formulas';

export interface Brands { brand: string; competitors: string[] }
export interface AiVisibilityInput extends Brands {
  domain: string | null; country: string; engines: EngineId[]; questions: string[];
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

// A brand name as the formulas embed it: plain text, no braces (a {{…}} would
// read a column) and no comment marks (the brand list sits between comments).
function brandName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = stripControlChars(v).replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim();
  if (!s || s.length > AI_VISIBILITY_MAX_BRAND_CHARS || /[{}]|\/\*|\*\//.test(s) || holdsRunMarker(s)) return null;
  return s;
}

export function parseBrands(v: Json): Brands | string {
  const brand = brandName(v.brand);
  if (!brand) {
    return `Give your brand's name: 1 to ${AI_VISIBILITY_MAX_BRAND_CHARS} characters, no { } or /* */.`;
  }
  const raw = v.competitors ?? [];
  if (!Array.isArray(raw) || raw.length > AI_VISIBILITY_MAX_COMPETITORS) {
    return `List at most ${AI_VISIBILITY_MAX_COMPETITORS} other brands.`;
  }
  const competitors: string[] = [];
  for (const c of raw) {
    const name = brandName(c);
    if (!name) return `Each other brand needs a name of 1 to ${AI_VISIBILITY_MAX_BRAND_CHARS} characters.`;
    if ([brand, ...competitors].some(b => b.toLowerCase() === name.toLowerCase())) continue;
    competitors.push(name);
  }
  // The longest formula holds the list once: it must stay under the formula cap.
  const longest = namedFirstFormula(ENGINES.map(e => engineColumns(e).answer), [brand, ...competitors]);
  if (longest.length > FORMULA_MAX_CHARS || youFormula('x', [brand, ...competitors]).length > FORMULA_MAX_CHARS) {
    return 'The brand names are too long together. Shorten or remove some.';
  }
  return { brand, competitors };
}

function parseDomain(v: unknown): string | null | undefined {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') return undefined;
  return cleanDomain(v) || undefined;
}

function parseEngines(v: unknown): EngineId[] | string {
  if (v === undefined || v === null) return ENGINES.filter(e => e.defaultOn).map(e => e.id);
  if (!Array.isArray(v) || v.length === 0) return `Pick at least one engine: ${ENGINES.map(e => e.id).join(', ')}.`;
  const out: EngineId[] = [];
  for (const id of v) {
    const e = typeof id === 'string' ? engineById(id) : undefined;
    if (!e) return `Unknown engine "${String(id).slice(0, 40)}". Pick from ${ENGINES.map(x => x.id).join(', ')}.`;
    if (!out.includes(e.id)) out.push(e.id);
  }
  // In the table's order, whatever order they were given in.
  return ENGINES.filter(e => out.includes(e.id)).map(e => e.id);
}

function parseQuestions(v: unknown): string[] | string {
  if (!Array.isArray(v)) return 'questions must be a list of the questions to ask.';
  const out: string[] = [];
  for (const q of v) {
    const s = typeof q === 'string' ? stripControlChars(q).replace(/\s+/g, ' ').trim() : '';
    if (!s) continue;
    if (s.length > AI_VISIBILITY_MAX_QUESTION_CHARS || holdsRunMarker(s)) {
      return `Each question is plain text of at most ${AI_VISIBILITY_MAX_QUESTION_CHARS} characters.`;
    }
    if (!out.some(x => x.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  if (out.length === 0) return 'Add at least one question, as a buyer would ask it.';
  if (out.length > AI_VISIBILITY_MAX_QUESTIONS) {
    return `Start with at most ${AI_VISIBILITY_MAX_QUESTIONS} questions (you can add rows later).`;
  }
  return out;
}

export function parseAiVisibilityInput(v: unknown): AiVisibilityInput | string {
  if (!isObj(v)) return 'Send your brand, the questions and the engines to ask.';
  const brands = parseBrands(v);
  if (typeof brands === 'string') return brands;
  const domain = parseDomain(v.domain);
  if (domain === undefined) return "Your site's domain isn't one (give it as acme.com).";
  const country = v.country === undefined || v.country === null ? 'US' : v.country;
  if (typeof country !== 'string' || !/^[A-Za-z]{2}$/.test(country)) {
    return 'country must be a two-letter country code, such as US or GB.';
  }
  const engines = parseEngines(v.engines);
  if (typeof engines === 'string') return engines;
  const questions = parseQuestions(v.questions);
  if (typeof questions === 'string') return questions;
  return { ...brands, domain, country: country.toUpperCase(), engines, questions };
}
