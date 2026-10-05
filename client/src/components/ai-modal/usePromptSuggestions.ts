import { useState } from 'react'
import { flushSync } from 'react-dom'

// Owns the /column autocomplete state for the prompt textarea, plus the actual
// "insert into textarea at caret" behavior.
// Grouped handle so consumers thread ONE prop instead of seven.
export type PromptSuggestionsHandle = ReturnType<typeof usePromptSuggestions>

export const usePromptSuggestions = (prompt: string, setPrompt: (v: string) => void) => {
  const [show, setShow] = useState(false)
  const [filter, setFilter] = useState('')
  const [activeIndex, setActiveIndex] = useState(-1)

  const insert = (reference: string) => {
    const textarea = document.querySelector('#prompt') as HTMLTextAreaElement | null
    if (!textarea) return
    const caret = textarea.selectionStart
    const before = prompt.substring(0, caret)
    const after = prompt.substring(caret)
    const slashIdx = before.lastIndexOf('/')
    // flushSync writes the new value to the textarea now, so the caret lands
    // before the next keystroke. Placing it in a setTimeout raced fast typing:
    // text typed right after Enter ended up behind the caret.
    const place = (pos: number) => { textarea.focus(); textarea.setSelectionRange(pos, pos) }
    if (slashIdx >= 0) {
      flushSync(() => setPrompt(prompt.substring(0, slashIdx) + reference + after))
      place(slashIdx + reference.length)
    } else {
      flushSync(() => setPrompt(before + reference + after))
      place(caret + reference.length)
    }
    setShow(false)
  }

  return { show, setShow, filter, setFilter, activeIndex, setActiveIndex, insert }
}
