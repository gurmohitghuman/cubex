import React, { useEffect, useRef, useState } from 'react'

interface LoadingCellRendererProps {
  value: string
  colDef: any
  data: any
}

// Detect "the server hasn't returned yet" state. Server seeds the placeholder
// as the literal string '⏳ Processing...' (see ai-run-start.ts); legacy
// runs may also produce '⏳ Loading...' or any value containing ⏳.
const isProcessingPlaceholder = (v: string) =>
  v === '⏳ Processing...' || v === '⏳ Loading...' || v.includes('⏳')

// Per-character delay for the typing effect (matches the marketing-site
// reference). Random jitter inside this range so the rhythm feels natural,
// not mechanical.
const TYPE_MIN_MS = 18
const TYPE_MAX_MS = 40

export const LoadingCellRenderer: React.FC<LoadingCellRendererProps> = ({ value, colDef, data }) => {
  const cellValue = value || ''

  // Local state for the typing animation. `displayed` is the substring
  // currently rendered; `typingTo` is the full target string while we're
  // typing (null when not animating).
  const [displayed, setDisplayed] = useState(cellValue)
  const [typingTo, setTypingTo] = useState<string | null>(null)

  // Track the previous cellValue so we can detect the "placeholder → real
  // value" transition that should trigger the typing animation. Using a ref
  // (not state) so the comparison doesn't itself cause a re-render.
  const prevCellValueRef = useRef<string>(cellValue)

  // Cancellation flag for in-flight typing loops. If a cell receives a new
  // value mid-animation (e.g. the user reruns the row, or SSE delivers a
  // correction), we stop the previous loop so it can't keep overwriting
  // `displayed` with stale substrings of the old value.
  const cancelRef = useRef<{ cancelled: boolean }>({ cancelled: true })

  useEffect(() => {
    const prev = prevCellValueRef.current
    prevCellValueRef.current = cellValue

    // Cancel any in-flight typing loop before deciding what to do next.
    cancelRef.current.cancelled = true

    // Transition: placeholder → real value. Type it in.
    if (isProcessingPlaceholder(prev) && !isProcessingPlaceholder(cellValue) && cellValue.length > 0) {
      const token = { cancelled: false }
      cancelRef.current = token
      setTypingTo(cellValue)
      setDisplayed('')
      ;(async () => {
        for (let i = 0; i < cellValue.length; i++) {
          if (token.cancelled) return
          setDisplayed(cellValue.slice(0, i + 1))
          const wait = TYPE_MIN_MS + Math.random() * (TYPE_MAX_MS - TYPE_MIN_MS)
          await new Promise(r => setTimeout(r, wait))
        }
        if (token.cancelled) return
        setTypingTo(null)
      })()
      return
    }

    // Any other change (placeholder appearing, stable value updating without
    // a typing transition, etc.) — render immediately, no animation.
    setTypingTo(null)
    setDisplayed(cellValue)
  }, [cellValue])

  // Loading state: server placeholder is the current value. Show only the
  // small spinning circle, vertically centered to the row.
  //
  // `absolute inset-0 + flex items-center` matches the row's actual content
  // box exactly (AG Grid sets the cell to position:relative with its own
  // padding). The wrapper takes the full cell height — `items-center` then
  // centers the spinner to the row's vertical midpoint, not the text
  // baseline of nearby cells.
  //
  // Horizontal position stays at the cell's left padding (no justify-center,
  // no -ml hack) so the spinner sits exactly where the row's text would
  // start — matches the column's left alignment.
  if (isProcessingPlaceholder(cellValue) && typingTo === null) {
    return (
      <div className="absolute inset-0 flex items-center">
        <span
          aria-label="loading"
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            // green-600 track with a lighter green-300 head so the rotation
            // reads against the ring (matches the codebase's green-* success hue).
            border: '1.5px solid #16a34a',
            borderTopColor: '#86efac',
            animation: 'cube-cell-spin 0.7s linear infinite',
            display: 'inline-block',
            marginLeft: 'var(--ag-cell-horizontal-padding, 12px)',
          }}
        />
        <style>{`
          @keyframes cube-cell-spin { to { transform: rotate(360deg); } }
        `}</style>
      </div>
    )
  }

  // AI Data columns (scraped sources): styled affordance only — NO click
  // handler. The previous version was a button that stopPropagation'd and
  // dispatched a CustomEvent nobody listened to, so it ATE the click; the
  // working path is AG Grid's onCellClicked → useSheetView.handleCellClick,
  // which opens the ScrapedDataModal. It also matched '📊 Scraped' while the
  // server writes '📊 Searched N sources…' (ai-row.ts), so the affordance
  // never even appeared on current data. startsWith('📊') covers both.
  if (colDef.field?.endsWith(' (Data)') && cellValue.startsWith('📊')) {
    return (
      <span className="text-cube-black hover:text-gray-600 text-sm underline font-semibold cursor-pointer">
        {cellValue}
      </span>
    )
  }

  // URLs render as a link. Once the typing animation completes (typingTo is
  // null AND the value is a stable URL), we render the anchor. While typing,
  // we still want the typed-in chars to appear in the plain-text style so
  // the URL doesn't "pop" from underline to a different layout mid-stroke.
  if (
    typingTo === null &&
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

  // Typing-in-progress: render the displayed substring with a blinking
  // cursor at the end. The cursor lives inside a ::after pseudo on the
  // wrapping span so it composes cleanly with the existing text-sm style.
  if (typingTo !== null) {
    return (
      <>
        <span className="text-sm cube-cell-cursor">{displayed}</span>
        <style>{`
          .cube-cell-cursor::after {
            content: '▊';
            margin-left: 1px;
            animation: cube-cell-blink 0.9s infinite;
          }
          @keyframes cube-cell-blink {
            0%, 50% { opacity: 1; }
            51%, 100% { opacity: 0; }
          }
        `}</style>
      </>
    )
  }

  // Default: stable real value, no animation.
  return <span className="text-sm">{displayed}</span>
}
