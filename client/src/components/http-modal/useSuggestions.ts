import { useEffect, useState } from 'react'
import { APIKeySuggestion, sheetsAPI, settingsAPI } from '@/utils/api'

// Autocomplete state for "/column" and "/api_key" references inside HTTP modal inputs.
// Tracks which input field is currently showing the dropdown and the filter typed after
// the slash. Exposes a key-handler the inputs can wire to onKeyDown.
export const useSuggestions = (
  isOpen: boolean,
  sheetId: string,
  insertReference: (reference: string, target: string) => void,
) => {
  const [columnSuggestions, setColumnSuggestions] = useState<Array<{ name: string; reference: string }>>([])
  const [apiKeySuggestions, setApiKeySuggestions] = useState<APIKeySuggestion[]>([])
  const [show, setShow] = useState(false)
  const [filter, setFilter] = useState('')
  const [activeIndex, setActiveIndex] = useState(-1)
  const [target, setTarget] = useState<string | null>(null)

  useEffect(() => {
    if (!isOpen) return
    sheetsAPI.getColumns(sheetId).then(setColumnSuggestions)
      .catch(err => console.error('Failed to load column suggestions:', err))
    settingsAPI.getAPIKeySuggestions().then(setApiKeySuggestions)
      .catch(err => console.error('Failed to load API key suggestions:', err))
  }, [isOpen, sheetId])

  const all = () => {
    const cols = columnSuggestions.filter(c => c.reference.toLowerCase().includes(filter))
    const keys = apiKeySuggestions.filter(k => k.reference.toLowerCase().includes(filter))
    return [
      ...cols.map(col => ({ ...col, type: 'column' as const })),
      ...keys.map(key => ({ ...key, type: 'api_key' as const })),
    ]
  }

  const dismiss = () => { setShow(false); setTarget(null) }

  // Watch for '/' triggers in any tracked input field. Caller passes the typed value
  // and a targetId we use to know which input is showing the dropdown.
  const handleInputChange = (value: string, targetId: string, updateFn: () => void) => {
    updateFn()
    const slashIdx = value.lastIndexOf('/')
    if (slashIdx >= 0 && slashIdx === value.length - 1) {
      setFilter(''); setShow(true); setTarget(targetId); setActiveIndex(0)
    } else if (slashIdx >= 0) {
      const after = value.substring(slashIdx + 1)
      if (!after.includes(' ') && !after.includes('&') && !after.includes('=')) {
        setFilter(after.toLowerCase()); setShow(true); setTarget(targetId); setActiveIndex(0)
      } else dismiss()
    } else dismiss()
  }

  const handleKeyDown = (e: React.KeyboardEvent, targetId: string) => {
    if (!show || target !== targetId) return
    const list = all()
    if (e.key === 'ArrowDown') {
      e.preventDefault(); setActiveIndex(i => Math.min(i + 1, list.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault(); setActiveIndex(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && list[activeIndex] && caretAtFilteredToken(e.currentTarget as HTMLInputElement, filter)) {
      e.preventDefault()
      if (target) { insertReference(list[activeIndex].reference, target); dismiss() }
    } else if (e.key === 'Escape') dismiss()
  }

  // insertReferenceInto replaces everything after the LAST '/', so Enter may
  // pick only while the caret sits at the end, right after the filtered token.
  // (A click or arrow key moves the caret without a change event.)
  const caretAtFilteredToken = (el: HTMLInputElement | HTMLTextAreaElement, f: string) =>
    el.selectionStart === el.value.length && el.value.slice(el.value.lastIndexOf('/') + 1).toLowerCase() === f

  const select = (reference: string) => {
    if (target) { insertReference(reference, target); dismiss() }
  }

  return { show, filter, activeIndex, suggestions: all(), handleInputChange, handleKeyDown, select, dismiss }
}
