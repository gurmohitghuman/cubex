// Whose a column is when a restored setup would write into it: a setup version's restore
// (services/setup-version-plan.ts) and a deleted column's (services/trash-restore-column-setup.ts) follow the
// same rule. It is the restored setup's when the restore adds it back, or when that setup had it filled by its
// column and nothing else fills it now (it is plain, or that column fills it already). A column another setup
// fills now stays with that setup: an HTTP API setup comes back without that field, an AI setup without that
// output. Pure.
import type { AiFill, ColumnKind, HttpFill } from './spec';

export type Kinds = Map<string, { kind: ColumnKind; by: string | null }>;
// back: the columns the restore adds back; exists: whether the sheet has a column now; was: the kinds the
// restored setup had them as (lib/setup-versions/spec.ts columnKinds); now: the sheet's kinds now.
export interface Owners { back: Set<string>; exists: (column: string) => boolean; was: Kinds; now: Kinds }

export const ownsColumn = (owner: string, c: string, o: Owners): boolean => o.back.has(c) || (o.exists(c)
  && o.was.get(c)?.kind === 'made' && o.was.get(c)?.by === owner
  && (o.now.get(c)!.kind === 'plain' || o.now.get(c)!.by === owner));

export const withoutFields = (f: HttpFill, gone: string[]): HttpFill => ({ ...f, config: { ...f.config,
  responseMapping: (f.config.responseMapping ?? []).filter((m: any) => !gone.includes(m?.columnName)) } });

export const withoutOutputs = (f: AiFill, gone: string[]): AiFill => ({ ...f,
  outputColumns: f.outputColumns ? f.outputColumns.filter(o => !gone.includes(o.columnName)) : null });
