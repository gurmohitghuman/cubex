import React, { ReactNode, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Loader2 } from 'lucide-react'

interface SidePanelProps {
  isOpen: boolean
  onClose: () => void
  // What it shows, read out by screen readers.
  label: string
  // Changes when it shows something else (another cell): focus goes into it again.
  openKey?: string
  // The second click of a double click whose first click opened it, landing on it (the cell was under it).
  onDoubleClickThrough?: () => void
  /** Width. Defaults to max-w-md, as Drawer's. */
  panelClassName?: string
  // Slides in when it opens (the default). Off when it takes the place of another side panel already on screen
  // (components/sheet/CellPanels.tsx): there is nothing to slide in from.
  slideIn?: boolean
  children: ReactNode
}

const editable = (el: Element | null) => !!el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)
  || (el as HTMLElement).isContentEditable)
// Something else takes Escape: a dialog, or the grid's editor.
const escapeTaken = () => !!document.querySelector('[aria-modal="true"], .ag-popup-editor, .ag-cell-inline-editing')

// A panel on the right that leaves the page usable, for what a click on a grid cell shows: no backdrop and no
// focus trap, so the grid keeps its clicks, double clicks and keys (Drawer is the modal one). It is on screen in
// the first frame after the click: it slides only its last quarter in (.cube-side-panel) and closes at once.
// Focus goes into it when it opens or shows another cell, and back to where it came from when it closes, unless
// it has moved on since (to another cell, or a double click's editor). Escape closes it from inside it, and from
// the page unless a field, a dialog or the grid's editor takes the Escape. Drawn on <body>, as dialogs are, so no
// ancestor's transform can move it. Compose with DrawerHeader and DrawerBody.
export const SidePanel: React.FC<SidePanelProps> = ({
  isOpen, onClose, label, openKey, onDoubleClickThrough, panelClassName, slideIn = true, children,
}) => {
  const ref = useRef<HTMLElement>(null)
  const latest = useRef({ onClose, onDoubleClickThrough })
  latest.current = { onClose, onDoubleClickThrough }
  // Clicked since it opened: a later double click on it is the panel's own.
  const clicked = useRef(false)

  useEffect(() => {
    const panel = ref.current
    if (!isOpen || !panel) return
    clicked.current = false
    const from = document.activeElement
    panel.focus({ preventScroll: true })
    return () => {
      const now = document.activeElement
      const stayed = !now || now === document.body || panel.contains(now)
      if (stayed && from instanceof HTMLElement && from.isConnected) from.focus({ preventScroll: true })
    }
  }, [isOpen, openKey])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const t = e.target instanceof Element ? e.target : null
      if (!(t && ref.current?.contains(t)) && (editable(t) || escapeTaken())) return
      e.preventDefault()
      latest.current.onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isOpen])

  if (!isOpen) return null
  return createPortal(
    <section ref={ref} role="dialog" aria-modal="false" aria-label={label} tabIndex={-1} data-testid="side-panel"
      className={`${slideIn ? 'cube-side-panel ' : ''}fixed inset-y-0 right-0 z-40 w-screen `
        + `${panelClassName || 'max-w-md'} bg-white border-l border-gray-200 shadow-xl flex flex-col outline-none`}
      onMouseDownCapture={e => {
        const through = latest.current.onDoubleClickThrough
        if (!clicked.current && e.detail >= 2 && through) {
          e.preventDefault(); e.stopPropagation()
          through()
        }
        clicked.current = true
      }}>
      {children}
    </section>,
    document.body,
  )
}

// A side panel's header mark while another row's content is on its way: small and quiet, and only once the wait is
// long enough to see (.cube-wait-mark in index.css).
export const PanelWait: React.FC<{ label: string }> = ({ label }) => (
  <span className="cube-wait-mark flex" role="status" aria-label={label} title={label} data-testid="panel-wait">
    <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
  </span>
)
