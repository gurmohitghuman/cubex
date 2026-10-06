import React from 'react'
import { Globe } from 'lucide-react'
import { OpenRouterCreditNotice } from '../OpenRouterCreditNotice'
import { PromptReferenceChips } from './PromptReferenceChips'
import { WebSearchOptions } from './WebSearchOptions'
import type { WebSearchSettings } from '@/utils/api'

// True while the text before the caret still ends with the /token the
// suggestion list is filtered by.
function caretEndsToken(el: HTMLTextAreaElement, filter: string): boolean {
  const before = el.value.slice(0, el.selectionStart ?? el.value.length)
  const slash = before.lastIndexOf('/')
  return slash >= 0 && before.slice(slash + 1).toLowerCase() === filter
}

interface Props {
  columnName: string
  setColumnName: (v: string) => void
  nameError: string
  prompt: string
  setPrompt: (v: string) => void
  useOpenRouterWebSearch: boolean
  setUseOpenRouterWebSearch: (v: boolean) => void
  // Engine, mode and per-row limit for web search, and the model they're priced for.
  model: string
  webSearch: WebSearchSettings
  setWebSearch: (v: WebSearchSettings) => void
  onSearchBlocked: (reason: string | null) => void
  useWebFetch: boolean
  setUseWebFetch: (v: boolean) => void
  columnSuggestions: Array<{ name: string; reference: string }>
  showSuggestions: boolean
  suggestFilter: string
  activeSuggestIndex: number
  setSuggestFilter: (s: string) => void
  setShowSuggestions: (b: boolean) => void
  setActiveSuggestIndex: React.Dispatch<React.SetStateAction<number>>
  insertColumnReference: (reference: string) => void
}

export const GenerateTab: React.FC<Props> = ({
  columnName, setColumnName, nameError, prompt, setPrompt,
  useOpenRouterWebSearch, setUseOpenRouterWebSearch,
  model, webSearch, setWebSearch, onSearchBlocked,
  useWebFetch, setUseWebFetch,
  columnSuggestions, showSuggestions, suggestFilter, activeSuggestIndex,
  setSuggestFilter, setShowSuggestions, setActiveSuggestIndex,
  insertColumnReference,
}) => (
  <div className="space-y-4">
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-2">Column Name *</label>
      <input type="text" className={`input w-full ${nameError ? '!border-red-300' : ''}`}
        placeholder="e.g., Industry Analysis, Sentiment Score"
        value={columnName} onChange={(e) => setColumnName(e.target.value)} />
      {nameError && <p className="text-sm text-red-600 mt-1">{nameError}</p>}
      <p className="text-xs text-gray-500 mt-1">This will be the name of your new AI-generated column</p>
    </div>

    <div className="space-y-3">
      <div>
        <label className="flex items-center space-x-2">
          <input type="checkbox" checked={useOpenRouterWebSearch}
            onChange={(e) => setUseOpenRouterWebSearch(e.target.checked)}
            className="border-gray-300 text-cube-black focus:ring-black" />
          <Globe className="h-4 w-4 text-gray-500" />
          <span className="text-sm text-gray-700">Web search</span>
        </label>
        <p className="text-xs text-gray-500 mt-1 ml-6">
          Let the AI search the web when it needs current info. Each search costs extra, on top
          of tokens, and is often most of a row&apos;s cost: choose the engine and limit the
          searches per row below.
        </p>
        {useOpenRouterWebSearch && (
          <WebSearchOptions model={model} value={webSearch} onChange={setWebSearch} onBlocked={onSearchBlocked} />
        )}
      </div>
      <div>
        <label className="flex items-center space-x-2">
          <input type="checkbox" checked={useWebFetch}
            onChange={(e) => setUseWebFetch(e.target.checked)}
            className="border-gray-300 text-cube-black focus:ring-black" />
          <Globe className="h-4 w-4 text-gray-500" />
          <span className="text-sm text-gray-700">Fetch URLs from referenced columns</span>
        </label>
        <p className="text-xs text-gray-500 mt-1 ml-6">
          For any <code className="px-1 bg-gray-100 rounded">/column</code> reference whose value
          is a URL, the AI can fetch that page (or PDF) and read it. Restricted to the hosts in
          those cells, so the model can&apos;t fetch arbitrary URLs. Estimated cost: about $0.001
          per page fetched.
        </p>
      </div>
    </div>

    <div>
      <div className="flex items-center justify-between gap-3 mb-2">
        <label className="block text-sm font-medium text-gray-700">What would you like AI to do? *</label>
        {/* Short neutral disclosure only. The no-key WARNING lives in the
            full-width banner at the top of the modal (ConfigureStep) — inline,
            its longer text wrapped and collided with this label. */}
        <OpenRouterCreditNotice neutralOnly className="flex-shrink-0" />
      </div>
      <div className="relative">
        <textarea id="prompt" className="input w-full h-24 resize-none"
          placeholder="Summarize /description into 1 sentence…"
          value={prompt}
          onChange={(e) => {
            const val = e.target.value
            setPrompt(val)
            const caret = (e.target as HTMLTextAreaElement).selectionStart || val.length
            const before = val.substring(0, caret)
            const slashIdx = before.lastIndexOf('/')
            if (slashIdx >= 0) {
              const afterSlash = before.substring(slashIdx + 1)
              // Only show suggestions while still in a valid /column_name token.
              const validToken = afterSlash.match(/^[A-Za-z0-9_\-]*$/)
              if (validToken && afterSlash === validToken[0]) {
                setSuggestFilter(afterSlash.toLowerCase()); setShowSuggestions(true); setActiveSuggestIndex(0)
              } else { setShowSuggestions(false) }
            } else { setShowSuggestions(false) }
          }}
          onKeyDown={(e) => {
            if (!showSuggestions) return
            const filtered = columnSuggestions.filter(c => c.reference.toLowerCase().includes(suggestFilter))
            if (e.key === 'ArrowDown') { e.preventDefault(); setActiveSuggestIndex(i => Math.min(i + 1, filtered.length - 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveSuggestIndex(i => Math.max(i - 1, 0)) }
            // A click or arrow key can move the caret off the /token without a
            // change event; Enter then stays a newline instead of replacing text.
            else if (e.key === 'Enter' && filtered[activeSuggestIndex] && caretEndsToken(e.currentTarget, suggestFilter)) { e.preventDefault(); insertColumnReference(filtered[activeSuggestIndex].reference) }
            else if (e.key === 'Escape') { setShowSuggestions(false) }
          }}
        />
        {showSuggestions && columnSuggestions.length > 0 && (
          <div className="absolute top-full left-0 w-full bg-white border border-gray-200 z-10 mt-1">
            <div className="p-2 border-b border-gray-100 flex items-center justify-between">
              <p className="text-xs text-gray-600">Type / to insert column • Enter to add</p>
              <span className="text-[10px] text-gray-400">{suggestFilter ? `filter: ${suggestFilter}` : ''}</span>
            </div>
            <div className="max-h-40 overflow-auto">
              {columnSuggestions
                .filter(col => col.reference.toLowerCase().includes(suggestFilter))
                .map((col, idx) => (
                  <button key={col.name} onClick={() => insertColumnReference(col.reference)}
                    className={`w-full text-left px-3 py-2 text-sm ${idx === activeSuggestIndex ? 'bg-cube-black text-white' : 'hover:bg-gray-100'}`}>
                    <span className={`font-mono ${idx === activeSuggestIndex ? 'text-white' : 'text-cube-black'}`}>{col.reference}</span>
                    <span className={`ml-2 ${idx === activeSuggestIndex ? 'text-gray-300' : 'text-gray-500'}`}>({col.name})</span>
                  </button>
                ))}
            </div>
          </div>
        )}
      </div>
      <PromptReferenceChips prompt={prompt} setPrompt={setPrompt} columnSuggestions={columnSuggestions} />
      <p className="text-xs text-gray-500 mt-1">Type / to reference another column</p>
    </div>
  </div>
)
