// Auto-run on a clean data column (an autorun_columns entry of kind 'clean'):
// the column follows its source, as every derived column follows its inputs
// (derived-follow.ts).
export { derivedFollowTick as cleanFollowTick } from './derived-follow';
