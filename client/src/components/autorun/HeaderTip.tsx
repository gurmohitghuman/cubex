import React, { useState } from 'react'
import { createPortal } from 'react-dom'

interface Props {
  text: string
  // Shown in amber under the text (why auto-run is paused).
  amber?: string | null
  children: React.ReactNode
}

// A hover note on a column header's icons. AG Grid clips whatever overflows a
// header cell, so the note is drawn on the page itself, just under the icons.
export const HeaderTip: React.FC<Props> = ({ text, amber, children }) => {
  const [at, setAt] = useState<DOMRect | null>(null)
  return (
    <span className="flex items-center gap-1 flex-shrink-0" data-testid="header-tip-anchor"
      onMouseEnter={e => setAt(e.currentTarget.getBoundingClientRect())} onMouseLeave={() => setAt(null)}>
      {children}
      {at && createPortal(
        <div role="tooltip" data-testid="header-tip"
          className="fixed z-50 max-w-xs bg-white border border-gray-200 shadow-md px-2.5 py-2 text-xs space-y-1"
          style={{ top: at.bottom + 6, left: Math.max(8, Math.min(at.left, window.innerWidth - 328)) }}>
          {text && <p className="text-gray-700 whitespace-pre-line break-words">{text}</p>}
          {amber && <p className="text-amber-700">{amber}</p>}
        </div>,
        document.body,
      )}
    </span>
  )
}
