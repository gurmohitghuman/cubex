// A tool that does one of several things (its action) takes some of its fields for each: those an action needs, and
// those it may take. A field another action takes is refused, naming what this one takes, and so is one it needs
// left out, so a mixed-up call says what to send instead of doing something else.
export interface ActionFields<F extends string> { needs?: readonly F[]; may?: readonly F[] }

export function actionFieldsProblem<A extends string, F extends string>(
  action: A, given: Partial<Record<F, unknown>>, takes: Record<A, ActionFields<F>>,
): string | null {
  const { needs = [], may = [] } = takes[action];
  const all = [...needs, ...may];
  const extra = (Object.keys(given) as F[]).filter(f => given[f] !== undefined && !all.includes(f));
  if (extra.length) {
    return `${extra.join(' and ')} ${extra.length > 1 ? 'are' : 'is'} not for ${action}: it takes `
      + `${all.length ? all.join(', ') : 'nothing else'}.`;
  }
  const missing = needs.filter(f => given[f] === undefined);
  return missing.length ? `${action} needs ${missing.join(' and ')}.` : null;
}
