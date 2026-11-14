import { useEffect } from 'react'
import { TOAST_TOP_PX } from '@/lib/constants'

// A page with the 56px bar at its top (the sheet, the dashboard) puts toasts below that bar while it is open:
// main.tsx's Toaster reads --toast-top, and keeps toasts 16px from the top when no page sets it.
export function useToastsBelowTopBar(): void {
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--toast-top', `${TOAST_TOP_PX}px`)
    return () => { root.style.removeProperty('--toast-top') }
  }, [])
}
