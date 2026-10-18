// Starter waterfalls (pure): a result type, the inputs it reads and its steps,
// as a start request takes them, for the app's start screen and for agents
// (waterfall_column's `template`). The inputs are mapped to the sheet's columns
// by whoever starts it; every step is checked against treg's catalog when it is
// built, like any other step, so a tool treg retires is said plainly then.
import { FREE_EMAIL_DOMAINS, SHARED_SITE_DOMAINS } from '../dedupe/shared-domains';
import type { StepInput } from './input-steps';
import { RESULT_INFO, type ResultType } from './result-type';

export const TEMPLATE_IDS = ['work_email', 'mobile_phone'] as const;
export type TemplateId = typeof TEMPLATE_IDS[number];

export interface WaterfallTemplate {
  id: TemplateId;
  title: string;
  description: string;
  resultType: ResultType;
  inputs: Array<{ key: string; label: string }>;
  steps: StepInput[];
}

const tool = (toolId: string, label: string): StepInput => ({
  id: null, label, on: true, requires: null, check: null,
  choices: {
    kind: 'enrichment', toolId, inputs: {}, providerOrder: [], skipProviders: [], stopAtFirst: false,
    valuePath: null, maxCostUsd: null,
  },
});

// Domains that are nobody's employer (free mail, social and link sites): no guess there.
const SHARED = JSON.stringify([...FREE_EMAIL_DOMAINS, ...SHARED_SITE_DOMAINS]);

// first.last@domain from the first and last name (or the full name's first and
// last words): text only, before any comma or bracket, titles and suffixes
// dropped, accents and ' - . taken out; no guess when a letter outside a-z is
// left. The domain is a website's or an address's, bare; none for free mail.
export const NAME_GUESS = String.raw`(() => {
  const text = v => (typeof v === 'string' ? v : '');
  const named = text({{first_name}}) && text({{last_name}})
    ? text({{first_name}}) + ' ' + text({{last_name}}) : text({{full_name}});
  const titles = ['dr', 'mr', 'mrs', 'ms', 'miss', 'prof', 'jr', 'sr', 'ii', 'iii', 'iv', 'phd', 'md', 'mba', 'cpa',
    'esq'];
  const words = named.split(/[,(|]/)[0].toLowerCase().normalize('NFD').replace(/\p{M}|['’.\-]/gu, '')
    .trim().split(/\s+/).filter(w => w && !titles.includes(w));
  const domain = text({{domain}}).toLowerCase().trim().replace(/^https?:\/\//, '').replace(/^.*@/, '')
    .split(/[/:?#]/)[0].replace(/^www\./, '');
  const shared = ${SHARED};
  if (words.length < 2 || words.some(w => !/^[a-z]+$/.test(w))) return '';
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(domain) || shared.includes(domain)) return '';
  return words[0] + '.' + words[words.length - 1] + '@' + domain;
})()`;

export const WATERFALL_TEMPLATES: readonly WaterfallTemplate[] = [
  {
    id: 'work_email', title: 'Work email from name + domain', resultType: 'email',
    description: "treg's email finder asks its providers in turn; where none finds one, a first.last@domain guess "
      + "counts only if treg's email verify says it's valid.",
    inputs: RESULT_INFO.email.inputs.map(i => ({ key: i.key, label: i.label })),
    steps: [
      tool('treg.people.email.find', 'treg email finder'),
      {
        id: null, label: 'Name guess', on: true, choices: { kind: 'formula', formula: NAME_GUESS },
        requires: [['first_name', 'last_name', 'domain'], ['full_name', 'domain']],
        check: { kind: 'verify', accept: 'safest' },
      },
    ],
  },
  {
    id: 'mobile_phone', title: 'Mobile or direct phone', resultType: 'phone',
    description: "treg's phone finder asks its providers in turn until one has the person's mobile or direct "
      + 'number.',
    inputs: RESULT_INFO.phone.inputs.map(i => ({ key: i.key, label: i.label })),
    steps: [tool('treg.people.phone.find', 'treg phone finder')],
  },
];

export const templateOf = (id: unknown): WaterfallTemplate | undefined =>
  WATERFALL_TEMPLATES.find(t => t.id === id);
