import { useCallback, useEffect, useState } from 'react'
import { CLOSE_AFTER_OPEN_MAX_MS } from '@/lib/constants'

// A drawer or dialog closed while it still opens (Escape or a click outside just after it opens) closes once its
// open transition has ended. Closed sooner, Headless UI's Transition (2.2.10, the newest) can cut the open short and
// never finish the close when the browser draws a frame before React applies it: the drawer stays on the page,
// invisible, and catches every click until a reload. The open transition runs 200 ms once it starts, so that is
// the usual wait; a close never waits longer than CLOSE_AFTER_OPEN_MAX_MS.
// Give `show` to Transition.Root, and beforeEnter and afterEnter to each Transition.Child.
export function useCloseAfterOpen(isOpen: boolean) {
  const [entering, setEntering] = useState(0) // children whose open transition is running
  const [held, setHeld] = useState(false) // closed while it opens: still shown until the open ends
  const [wasOpen, setWasOpen] = useState(isOpen)
  if (wasOpen !== isOpen) {
    setWasOpen(isOpen)
    setHeld(!isOpen && entering > 0)
  }
  // Let the close through once every child has opened, or after the longest wait.
  useEffect(() => {
    if (!held) return
    if (entering === 0) { setHeld(false); return }
    const timer = setTimeout(() => { setEntering(0); setHeld(false) }, CLOSE_AFTER_OPEN_MAX_MS)
    return () => clearTimeout(timer)
  }, [held, entering])
  const beforeEnter = useCallback(() => setEntering(n => n + 1), [])
  const afterEnter = useCallback(() => setEntering(n => Math.max(0, n - 1)), [])
  return { show: isOpen || held, beforeEnter, afterEnter }
}
