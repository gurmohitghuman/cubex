// AI engine answers (cloro's app scrapers and treg's Perplexity job), made
// up from the question so specs can check which brands an answer names and in
// what order. Brands and sites are fictional or generic. Each engine has its
// own habit: ChatGPT names Northdesk, then Acme CRM; Gemini names Pipewell
// only; AI Mode names Acme CRM first; Copilot names nobody; Perplexity names
// Northdesk. "nobody" in the question answers nothing (an empty answer).
// Steering (/__mock/state): aiQuiet [engine words] answers that engine with
// no sources.
import { state } from './state.mjs'

const ENGINE = {
  'cloro.ai-search.chatgpt.scrape': 'chatgpt',
  'cloro.ai-search.gemini.scrape': 'gemini',
  'cloro.google.serp.ai_mode': 'ai_mode',
  'cloro.ai-search.copilot.scrape': 'copilot',
  'treg.ai-search.perplexity.answer': 'perplexity',
}
const TEXT = {
  chatgpt: q => `For "${q}": Northdesk is the usual pick. Acme CRM suits small teams too.`,
  gemini: q => `On "${q}", most people choose Pipewell.`,
  ai_mode: q => `Acme CRM leads for "${q}", ahead of Northdesk and Clientry.`,
  copilot: q => `There are many tools for "${q}"; compare a few.`,
  perplexity: q => `Northdesk answers "${q}" best.`,
}
const SITES = {
  chatgpt: ['https://www.reddit.com/r/smallbusiness/comments/crm', 'https://acme-crm.com/pricing'],
  gemini: ['https://www.g2.com/categories/crm'],
  ai_mode: ['https://www.youtube.com/watch?v=crm-review', 'https://blog.acme-crm.com/guide'],
  copilot: [],
  perplexity: ['https://www.reddit.com/r/sales/comments/crm-tools'],
}

export const isAiSearch = (toolId) => toolId in ENGINE

function parts(toolId, body) {
  const engine = ENGINE[toolId]
  const q = String(body.prompt ?? '')
  const quiet = (state.aiQuiet ?? []).includes(engine)
  return { engine, q, text: TEXT[engine](q), sites: quiet ? [] : SITES[engine] }
}

// A cloro scraper's answer: {success, result: {text, sources}}.
export function aiSearchAnswer(toolId, body) {
  if (String(body.prompt ?? '').toLowerCase().includes('nobody')) return {}
  const { text, sites } = parts(toolId, body)
  return {
    success: true,
    result: {
      text, sources: sites.map((url, i) => ({ position: i + 1, label: `Source ${i + 1}`, url, description: '' })),
    },
  }
}

// treg's Perplexity job, as its model-API provider answers: {output: {answer, sources, source_kind}}.
export function perplexityAnswer(body) {
  if (String(body.prompt ?? '').toLowerCase().includes('nobody')) return {}
  const { text, sites } = parts('treg.ai-search.perplexity.answer', body)
  return {
    output: {
      answer: text, sources: sites.map((url, i) => ({ title: `Thread ${i + 1}`, url })), source_kind: 'model_api',
    },
  }
}
