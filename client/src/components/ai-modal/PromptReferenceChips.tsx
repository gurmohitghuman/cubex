import React, { useMemo } from 'react'
import { X } from 'lucide-react'

// Visual confirmation of which /column references the user has put in the
// prompt. Reads the prompt string, finds every /token, intersects with the
// real columns this sheet has, and shows valid refs as blue chips and unknown
// refs as red chips. Click the × to strip that reference from the prompt.
// Lives below the textarea (Clay-style chip strip) so the textarea stays
// plain — no rich-text editor required.
const TOKEN_REGEX = /\/([A-Za-z0-9_-]+)/g

interface ChipProps {
  prompt: string
  setPrompt: (v: string) => void
  columnSuggestions: Array<{ name: string; reference: string }>
}

export const PromptReferenceChips: React.FC<ChipProps> = ({ prompt, setPrompt, columnSuggestions }) => {
  const validRefs = useMemo(() => {
    const set = new Set<string>()
    for (const c of columnSuggestions) set.add(c.reference.toLowerCase())
    return set
  }, [columnSuggestions])

  // De-duped list of references found in the prompt, in order of first appearance.
  // We dedupe so the chip strip doesn't repeat the same /name three times if
  // the user used it three times in the prompt.
  const chips = useMemo(() => {
    const seen = new Set<string>()
    const out: Array<{ reference: string; valid: boolean }> = []
    for (const match of prompt.matchAll(TOKEN_REGEX)) {
      const ref = match[0]
      const key = ref.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ reference: ref, valid: validRefs.has(key) })
    }
    return out
  }, [prompt, validRefs])

  if (chips.length === 0) return null

  // Remove every occurrence of this reference (and any immediately-following
  // single space, so we don't leave double-spaces in the prompt). Case-sensitive
  // strip matches the case-sensitive lookup the server does in processPromptTemplate.
  const removeRef = (ref: string) => {
    const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(escaped + '\\s?', 'g')
    setPrompt(prompt.replace(pattern, ''))
  }

  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {chips.map(({ reference, valid }) => (
        <span
          key={reference}
          className={
            'inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono ' +
            (valid
              ? 'bg-gray-100 text-gray-700'
              : 'bg-red-100 text-red-700')
          }
          title={valid ? 'Valid column reference' : 'Column not found in this sheet'}
        >
          {reference}
          <button
            type="button"
            onClick={() => removeRef(reference)}
            className={
              'p-0.5 rounded hover:bg-opacity-60 ' +
              (valid ? 'hover:bg-gray-200' : 'hover:bg-red-200')
            }
            aria-label={`Remove ${reference}`}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
    </div>
  )
}
