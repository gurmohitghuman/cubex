import { useCallback, useEffect, useRef, useState } from 'react'
import { readError, TypedReads, type Read, type ReadAnswer, type TypedReadOptions } from '@/lib/typedReads'
import { typingWait, watchActions } from '@/lib/typingWait'

// A box's reads (lib/typedReads.ts), for a component: `ask(key, read)` from an effect on the box's text. A change
// waits as lib/typingWait.ts says (after a key, not after a click), unless the box or the call sets its own wait.
// Made in an effect and stopped in its cleanup, so closing the box aborts its read, and React's development double
// mount gets a live one. Effects run in order, so this one's must come before the effect that asks.
export function useTypedReads<T>(onAnswer: (a: ReadAnswer<T>) => void, opts: TypedReadOptions = {}) {
  const answer = useRef(onAnswer)
  answer.current = onAnswer
  const reads = useRef<TypedReads<T> | null>(null)
  const { waitMs: boxWait, cancels } = opts
  useEffect(() => {
    watchActions()
    const own = new TypedReads<T>(a => answer.current(a), { waitMs: boxWait, cancels })
    reads.current = own
    return () => { own.stop(); if (reads.current === own) reads.current = null }
  }, [boxWait, cancels])
  return useCallback((key: string, read: Read<T> | null, waitMs?: number) =>
    reads.current?.ask(key, read, waitMs ?? boxWait ?? typingWait()), [boxWait])
}

// A dialog's preview, read as its form changes (lib/typedReads.ts): the newest answer stays on screen while the
// next one loads, so the table doesn't flicker; a failed one is cleared with the server's reason.
export interface PreviewState<R> {
  loading: boolean
  result: R | null
  error: string | null
}

const IDLE = { loading: false, result: null, error: null }

export function usePreviewRead<B, R>(
  sheetId: string, body: B | null, preview: (sheetId: string, body: B, signal: AbortSignal) => Promise<R>,
  fallback: string,
): PreviewState<R> {
  const [state, setState] = useState<PreviewState<R>>(IDLE)
  const key = body ? JSON.stringify(body) : ''
  const ask = useTypedReads<R>(a => setState(a.ok ? { loading: false, result: a.value, error: null }
    : { loading: false, result: null, error: readError(a.error, fallback) }))
  useEffect(() => {
    if (!key) { setState(IDLE); ask('', null); return }
    setState(s => ({ ...s, loading: true }))
    ask(`${sheetId}\n${key}`, signal => preview(sheetId, JSON.parse(key) as B, signal))
  }, [sheetId, key, ask]) // eslint-disable-line react-hooks/exhaustive-deps
  return state
}
