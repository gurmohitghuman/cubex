// Which providers one treg answer asked and how each went (pure). A waterfall
// lists them in _treg.tried ({provider, outcome: hit|weak|miss|error|skipped,
// status, charged_micro}); a single tool names the one that served it
// (X-Treg-Served-By), and its own status says how. treg's words, as sent.
import { providerOf, type TregMeta } from './treg-meta';

export interface ProviderTry {
  provider: string;
  outcome: 'hit' | 'miss' | 'error' | 'skipped';
  status: number | null;
  chargedMicro: number;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const MAX_TRIES = 100;

function outcomeOf(word: unknown, status: number | null): ProviderTry['outcome'] {
  const w = typeof word === 'string' ? word.toLowerCase() : '';
  if (w === 'hit' || w === 'weak') return 'hit';
  if (w === 'miss' || w === 'skipped' || w === 'error') return w;
  return status !== null && status >= 200 && status < 300 ? 'miss' : 'error';
}

export function providerTries(body: unknown, meta: TregMeta, status: number | null): ProviderTry[] {
  const t = isObj(body) && isObj(body._treg) ? body._treg : null;
  if (t && Array.isArray(t.tried)) {
    return t.tried.filter(isObj).slice(0, MAX_TRIES).flatMap((s): ProviderTry[] => {
      const provider = typeof s.provider === 'string' ? s.provider.toLowerCase().slice(0, 100) : '';
      if (!provider) return [];
      const st = typeof s.status === 'number' ? s.status : null;
      const charged = typeof s.charged_micro === 'number' && s.charged_micro > 0 ? Math.round(s.charged_micro) : 0;
      return [{ provider, outcome: outcomeOf(s.outcome, st), status: st, chargedMicro: charged }];
    });
  }
  // A single tool: one provider, if treg said which.
  const provider = providerOf(meta.servedBy)?.toLowerCase();
  if (!provider) return [];
  const ok = status !== null && status >= 200 && status < 300;
  return [{
    provider, outcome: ok ? outcomeOf(t?.outcome ?? 'hit', status) : 'error', status,
    chargedMicro: meta.costMicro !== null && meta.costMicro > 0 ? meta.costMicro : 0,
  }];
}
