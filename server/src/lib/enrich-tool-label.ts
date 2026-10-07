// How an enrichment tool is named on a card (pure). treg's own wording is kept,
// minus its em dashes (Cubex copy has none): "Enrich a company by domain —
// 80+ datapoints" reads "Enrich a company by domain: 80+ datapoints".
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);

export function plainText(text: string): string {
  return text.split(EM_DASH).map(part => part.trim()).filter(Boolean).join(': ').split(EN_DASH).join('-');
}

// A waterfall is named by its job, the first clause of treg's capability
// description: "Find people by role, company or location — lead lists and
// prospects" → "Find people by role, company or location". Its own name
// ("people.search — routed: best of 24 providers…") is for agents.
export function jobTitle(capabilityDescription: string | null, capability: string | null, name: string): string {
  const first = (capabilityDescription ?? '').split(EM_DASH)[0].split(';')[0].trim().replace(/\.$/, '');
  if (first) return first;
  if (capability) {
    const words = capability.replace(/[._]+/g, ' ').trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  return plainText(name);
}

interface Named { kind: 'waterfall' | 'single'; name: string; capability: string | null; capabilityDescription: string | null }

// The card title: a Popular job's own title, a waterfall's job, or a single
// provider's name for its tool ("Find a verified work email").
export function toolTitle(tool: Named, featuredTitle?: string): string {
  if (featuredTitle) return featuredTitle;
  return tool.kind === 'waterfall' ? jobTitle(tool.capabilityDescription, tool.capability, tool.name) : plainText(tool.name);
}
