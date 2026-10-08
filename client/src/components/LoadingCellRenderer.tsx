import React, { useLayoutEffect, useRef, useState } from 'react'
import { startTyping } from './aggrid/typingTicker'

interface LoadingCellRendererProps {
  value: string
  colDef: any
}

// Detect "the server hasn't returned yet" state. Server seeds the placeholder
// as the literal string '⏳ Processing...' (see ai-run-start.ts); legacy
// runs may also produce '⏳ Loading...' or any value containing ⏳.
const isProcessingPlaceholder = (v: string) =>
  v === '⏳ Processing...' || v === '⏳ Loading...' || v.includes('⏳')

// An AI "(Data)" sources cell renders as its link-styled affordance straight away.
const isDataAffordance = (field: string | undefined, v: string) => !!field?.endsWith(' (Data)') && v.startsWith('📊')

// A placeholder just turned into a real value: the moment to type it in.
const justArrived = (prev: string, next: string, field: string | undefined) =>
  isProcessingPlaceholder(prev) && !isProcessingPlaceholder(next) && next.length > 0 && !isDataAffordance(field, next)

export const LoadingCellRenderer: React.FC<LoadingCellRendererProps> = ({ value, colDef }) => {
  const cellValue = value || ''

  // Placeholder -> real value: type it in. Decided DURING render (React's
  // "adjust state on prop change" pattern) so the first paint of the new value
  // is already the empty typing span, never a flash of the full text.
  const [prevValue, setPrevValue] = useState(cellValue)
  const [typingFor, setTypingFor] = useState<string | null>(null)
  if (cellValue !== prevValue) {
    setPrevValue(cellValue)
    setTypingFor(justArrived(prevValue, cellValue, colDef.field) ? cellValue : null)
  }

  // The shared ticker (aggrid/typingTicker.ts) writes the text into this span;
  // React renders it empty and never touches its text. Before paint, so the
  // span starts empty. A newer value, unmount or a full ticker ends it.
  const typingSpanRef = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    if (typingFor === null || !typingSpanRef.current) return
    const cancel = startTyping(typingSpanRef.current, typingFor, () => setTypingFor(null))
    if (!cancel) { setTypingFor(null); return }
    return cancel
  }, [typingFor])

  // Loading state: server placeholder is the current value. Show only the
  // small spinning circle (.cube-cell-spinner in ag-grid-custom.css), centred on
  // the row: `absolute inset-0 + flex items-center` matches the cell's content
  // box (AG Grid sets the cell position:relative with its own padding), and the
  // spinner sits at the cell's left padding, where the row's text would start.
  if (isProcessingPlaceholder(cellValue)) {
    return (
      <div className="absolute inset-0 flex items-center">
        <span aria-label="loading" className="cube-cell-spinner" />
      </div>
    )
  }

  // Typing in progress: the ticker fills this span; the blinking cursor is its
  // ::after (.cube-cell-cursor). Plain text style, so a URL doesn't jump from
  // text to link layout mid-stroke.
  if (typingFor === cellValue) return <span ref={typingSpanRef} className="text-sm cube-cell-cursor" />

  // AI Data columns (scraped sources): styled affordance only — NO click
  // handler. The previous version was a button that stopPropagation'd and
  // dispatched a CustomEvent nobody listened to, so it ATE the click; the
  // working path is AG Grid's onCellClicked → useSheetView.handleCellClick,
  // which opens the ScrapedDataModal. It also matched '📊 Scraped' while the
  // server writes '📊 Searched N sources…' (ai-row.ts), so the affordance
  // never even appeared on current data. startsWith('📊') covers both.
  if (isDataAffordance(colDef.field, cellValue)) {
    return (
      <span className="text-cube-black hover:text-gray-600 text-sm underline font-semibold cursor-pointer">
        {cellValue}
      </span>
    )
  }

  // URLs render as a link once typed in.
  if (
    typeof cellValue === 'string' &&
    (cellValue.startsWith('http://') || cellValue.startsWith('https://'))
  ) {
    return (
      <a
        href={cellValue}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="text-cube-black hover:text-gray-600 underline text-sm"
      >
        {cellValue}
      </a>
    )
  }

  // Default: stable real value, no animation.
  return <span className="text-sm">{cellValue}</span>
}
