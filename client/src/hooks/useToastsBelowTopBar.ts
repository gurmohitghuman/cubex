import { useEffect } from 'react'
import { TOAST_TOP_PX } from '@/lib/constants'

// The gap between the bar and a toast below it (TOAST_TOP_PX is the one-row 56px bar plus this gap).
const GAP_PX = TOAST_TOP_PX - 56

// A page with a bar at its top (the sheet, the dashboard) puts toasts below that bar while it is open: main.tsx's
// Toaster reads --toast-top, and keeps toasts 16px from the top when no page sets it. The bar is measured, not
// assumed: on a phone the sheet's header wraps to two rows (SheetHeader.tsx), and a toast at the one-row height
// would lie over its buttons. Until the bar is found, the one-row height.
export function useToastsBelowTopBar(): void {
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--toast-top', `${TOAST_TOP_PX}px`)
    const bar = document.querySelector('header')
    const place = () => {
      if (!bar) return
      root.style.setProperty('--toast-top', `${Math.round(bar.getBoundingClientRect().bottom) + GAP_PX}px`)
    }
    place()
    const seen = bar && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null
    if (bar) seen?.observe(bar)
    return () => { seen?.disconnect(); root.style.removeProperty('--toast-top') }
  }, [])
}
