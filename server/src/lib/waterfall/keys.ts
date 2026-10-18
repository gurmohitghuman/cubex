// What makes two waterfall steps "the same" (pure). settingsKey names a step's
// setup (its kind and every choice that changes what it answers, plus the
// result type that reads the answer): the estimate reads answer rates from
// earlier runs' tallies with the same key. answerKey adds the input values the
// step reads, so a finished step's answer can be replayed at no cost: by the
// row's own resume (the journal) or by a later run after a dry run. A label
// or on/off switch never changes either key. tallyKey adds the step's check:
// the answers a step's tally counts are the ones that passed it. checkKey
// names a check's result on one value.
import { createHash } from 'node:crypto';
import { extractColumnReferences, normalizeColumnName } from '../prompt';
import { extractTemplateTokenNames } from '../template-tokens';
import type { WaterfallBlock, WaterfallStep } from './config';

const sha = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 40);

function settingsOf(step: WaterfallStep): unknown {
  const c = step.choices;
  const b = step.built;
  switch (c.kind) {
    case 'enrichment': {
      const built = b.kind === 'enrichment' ? b : null;
      const inputs = Object.entries(c.inputs).sort(([a], [z]) => a.localeCompare(z));
      return ['e', c.toolId, inputs, built?.route.prefer ?? [], [...(built?.route.exclude ?? [])].sort(),
        built?.route.stopAtFirst ?? false, built?.valuePath ?? c.valuePath, built?.capUsd ?? null,
        built?.cleanDomains ?? true];
    }
    case 'ai': return ['a', c.prompt, b.kind === 'ai' ? b.model : c.model, c.webSearch];
    case 'http': {
      const headers = Object.entries(c.headers).sort(([a], [z]) => a.localeCompare(z));
      return ['h', c.method.toUpperCase(), c.url, headers, c.body ?? '', c.valuePath];
    }
    case 'formula': return ['f', c.formula];
    case 'lookup': return ['l', c.sheetId, c.matchColumn, c.mode, c.inputKey, c.returnColumn];
  }
}

export function settingsKey(w: Pick<WaterfallBlock, 'resultType' | 'phone'>, step: WaterfallStep): string {
  return sha(['wf1', w.resultType, w.phone ?? null, settingsOf(step)]);
}

export function tallyKey(w: Pick<WaterfallBlock, 'resultType' | 'phone'>, step: WaterfallStep): string {
  const check = step.check?.choices ?? null;
  return check ? sha(['wft1', settingsKey(w, step), check]) : settingsKey(w, step);
}

const formulaRefs = (formula: string): string[] => [...formula.matchAll(/\{\{([^{}]+)\}\}/g)].map(m => m[1].trim());

// A check's result on a value: its setup, the value, and the inputs a formula check reads.
export function checkKey(step: WaterfallStep, value: string, inputs: Record<string, string>): string | null {
  const ch = step.check?.choices;
  if (!ch) return null;
  const reads = ch.kind === 'formula' ? [...new Set(formulaRefs(ch.formula))].filter(k => k !== 'value').sort() : [];
  const built = step.check?.built.kind === 'verify' ? step.check.built.tool.id : null;
  return sha(['wfc1', ch, built, value, reads.map(k => [k, inputs[k] ?? ''])]);
}

// The waterfall input keys a step reads.
export function stepReads(step: WaterfallStep, inputKeys: readonly string[]): string[] {
  const known = new Set(inputKeys);
  const byToken = (names: string[]) => {
    const out = new Set<string>();
    for (const n of names) {
      const hit = inputKeys.find(k => k === n || normalizeColumnName(n) === k);
      if (hit) out.add(hit);
    }
    return [...out];
  };
  const c = step.choices;
  switch (c.kind) {
    case 'enrichment':
      return [...new Set(Object.values(c.inputs).filter((v): v is string => typeof v === 'string' && known.has(v)))];
    case 'ai': return byToken(extractColumnReferences(c.prompt));
    case 'http':
      return byToken([c.url, c.body ?? '', ...Object.entries(c.headers).flat()].flatMap(extractTemplateTokenNames));
    case 'formula': return byToken(formulaRefs(c.formula));
    case 'lookup': return known.has(c.inputKey) ? [c.inputKey] : [];
  }
}

export function answerKey(settings: string, reads: readonly string[], inputs: Record<string, string>): string {
  const values = [...reads].sort().map(k => [k, inputs[k] ?? '']);
  return sha(['wfa1', settings, values]);
}
