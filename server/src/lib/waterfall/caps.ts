// What a waterfall's steps can cost (pure): each step's ceiling (its call and
// its check), the treg part of it (today's enrichment limit counts that), and
// how that limit is checked when some treg price is unknown.
import { rowSteps, type WaterfallRunConfig, type WaterfallStep } from './config';

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

export const isPaidStep = (s: WaterfallStep): boolean => s.built.kind === 'enrichment' || s.built.kind === 'ai'
  || s.check?.built.kind === 'verify';
// The step calls treg: its tool, or its email verify check.
export const usesTreg = (s: WaterfallStep): boolean =>
  s.built.kind === 'enrichment' || s.check?.built.kind === 'verify';
const checkCapUsd = (s: WaterfallStep): number => (s.check?.built.kind === 'verify' ? s.check.built.capUsd ?? 0 : 0);
// The treg part of the most a step can cost: its tool and its verify check (unpriced counts 0).
export const stepTregCapUsd = (s: WaterfallStep): number =>
  (s.built.kind === 'enrichment' ? s.built.capUsd ?? 0 : 0) + checkCapUsd(s);
// The most one step can cost a row: its call and its check.
export const stepCapUsd = (s: WaterfallStep): number =>
  stepTregCapUsd(s) + (s.built.kind === 'ai' ? s.built.capUsd : 0);

// A row's most (every step it walks, checks included) and the treg part of it.
export function rowCaps(steps: readonly WaterfallStep[]): { most: number; treg: number } {
  return {
    most: round6(steps.reduce((sum, s) => sum + stepCapUsd(s), 0)),
    treg: round6(steps.reduce((sum, s) => sum + stepTregCapUsd(s), 0)),
  };
}

// The treg part of the steps a row walks: whether one runs (today's
// enrichment limit applies) and whether one has no known price (its tool
// should bill the team's own provider key; that limit then stops on what treg
// really charged, as an enrichment run's does).
export function tregPart(config: WaterfallRunConfig): { any: boolean; unpriced: boolean } {
  const steps = rowSteps(config);
  const tools = steps.filter(s => s.built.kind === 'enrichment');
  const checks = steps.flatMap(s => (s.check?.built.kind === 'verify' ? [s.check.built] : []));
  return {
    any: tools.length + checks.length > 0,
    unpriced: tools.some(s => s.built.kind === 'enrichment' && s.built.capUsd === null)
      || checks.some(c => c.capUsd === null),
  };
}

// The per-row cap today's limit is checked with: the priced treg part (room
// for it is waited for; what treg really charged counts in what's spent), or
// null when only unpriced treg steps run (it stops on what treg charged).
export const dayCapOf = (tregCapUsd: number, unpriced: boolean): number | null =>
  (tregCapUsd > 0 ? tregCapUsd : unpriced ? null : 0);
