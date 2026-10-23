// What each simulated provider answers (deterministic, steered by /__mock/state):
//   find:   a value containing "nobody" misses everywhere; findMisses {domain
//           part: n} makes the first n providers tried miss; each provider
//           finds its own address pattern (so a re-find without it finds
//           another), unless sameEmail lists the domain; verifiedDomains makes
//           finders mark the address verified.
//   verify: ContactOut's free route answers 429 (as live), the next decides:
//           verdicts {address: word}, else "invalid", "risky" or "catchall"
//           (accept_all) anywhere in the address, otherwise valid.
//   lists:  each provider's own rows (lists.mjs), at most `limit` of them.
//   others: a hit with a value per contract field, a miss for "nobody".
import { fixture, state } from './state.mjs'
import { listAnswer, listField } from './lists.mjs'
import { perplexityAnswer } from './ai-search.mjs'

const PATTERNS = [
  (f, l) => `${f}.${l}`, (f, l) => `${f[0]}${l}`, (f, l) => f, (f, l) => `${f}${l}`, (f, l) => `${f}_${l}`,
]
const ascii = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9-]/g, '')
const hasNobody = (body) => Object.values(body ?? {}).some(v => String(v).toLowerCase().includes('nobody'))
const matches = (domain, keys) => (keys ?? []).some(k => domain.includes(String(k).toLowerCase()))

function names(body) {
  const words = String(body.full_name ?? '').trim().split(/\s+/).filter(Boolean)
  return {
    first: ascii(body.first_name ?? words[0] ?? 'pat'),
    last: ascii(body.last_name ?? words[words.length - 1] ?? 'doe'),
  }
}

function find(p, n, body) {
  const domain = String(body.domain ?? body.company_domain ?? 'example.example').toLowerCase()
  if (hasNobody(body)) return {}
  const misses = Object.entries(state.findMisses ?? {}).find(([k]) => domain.includes(k.toLowerCase()))
  if (misses && n < Number(misses[1])) return {}
  const { first, last } = names(body)
  const local = matches(domain, state.sameEmail)
    ? PATTERNS[0](first, last) : PATTERNS[p.planIndex % PATTERNS.length](first, last)
  return {
    output: {
      email: `${local}@${domain}`, first_name: first, last_name: last, confidence: 90,
      verified: matches(domain, state.verifiedDomains) ? true : null,
    },
  }
}

function verify(p, body) {
  if (p.provider === 'contactout') return { error: 429 }
  const email = String(body.email ?? '').toLowerCase()
  const word = state.verdicts?.[email]
    ?? (email.includes('invalid') ? 'invalid' : email.includes('risky') ? 'risky'
      : email.includes('catchall') ? 'accept_all' : 'valid')
  return { output: { valid: word === 'valid', status: word } }
}

function generic(toolId, body) {
  if (hasNobody(body)) return {}
  const seed = String(Object.values(body ?? {})[0] ?? 'x')
  const contract = fixture(`catalog/endpoints/${toolId}.json`).routing.contract.output
  const output = {}
  for (const [k, def] of Object.entries(contract)) {
    if (def?.type === 'list') continue
    output[k] = def?.type === 'integer' || def?.type === 'number' ? 120 : `${k} for ${seed}`
  }
  return { output }
}

export function providerAnswer(toolId, p, n, body) {
  if (toolId === 'treg.ai-search.perplexity.answer') return perplexityAnswer(body)
  if (toolId === 'treg.people.email.find') return find(p, n, body)
  if (toolId === 'treg.people.email.verify') return verify(p, body)
  if (listField(toolId)) return listAnswer(toolId, p, body)
  return generic(toolId, body)
}
