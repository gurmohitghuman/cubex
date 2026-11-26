import { useCallback, useEffect, useState } from 'react'

// The sidebar's place in this browser (localStorage; a private window or blocked storage starts expanded and
// forgets). Under 768 px it is always collapsed, to its icons, and can't be expanded: the page needs the room.
const KEY = 'cubex.sidebarCollapsed'
const NARROW = '(max-width: 767px)'

const remembered = (): boolean => {
  try { return localStorage.getItem(KEY) === '1' } catch { return false }
}
const narrowNow = (): boolean => typeof window !== 'undefined' && !!window.matchMedia?.(NARROW).matches

export function useSidebarCollapsed(): { collapsed: boolean; narrow: boolean; toggle: () => void } {
  const [chosen, setChosen] = useState(remembered)
  const [narrow, setNarrow] = useState(narrowNow)
  useEffect(() => {
    const query = window.matchMedia?.(NARROW)
    if (!query) return
    const changed = () => setNarrow(query.matches)
    query.addEventListener('change', changed)
    return () => query.removeEventListener('change', changed)
  }, [])
  const toggle = useCallback(() => setChosen(was => {
    try { localStorage.setItem(KEY, was ? '0' : '1') } catch { /* not remembered, still toggled */ }
    return !was
  }), [])
  return { collapsed: narrow || chosen, narrow, toggle }
}
