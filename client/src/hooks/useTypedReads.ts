import { useCallback, useEffect, useRef, useState } from 'react'
import { readError, TypedReads, type Read, type ReadAnswer, type TypedReadOptions } from '@/lib/typedReads'

// A box's reads (lib/typedReads.ts), for a component: `ask(key, read)` from an effect on the box's text. Made in
// an effect and stopped in its cleanup, so closing the box aborts its read, and React's development double mount
// gets a live one. Effects run in order, so this one's must come before the effect that asks.
export function useTypedReads<T>(onAnswer: (a: ReadAnswer<T>) => void, opts: TypedReadOptions = {}) {
  const answer = useRef(onAnswer)
  answer.current = onAnswer
  const reads = useRef<TypedReads<T> | null>(null)
  const { waitMs, paced } = opts
  useEffect(() => {
    const own = new TypedReads<T>(a => answer.current(a), { waitMs, paced })
    reads.current = own
    return () => { own.stop(); if (reads.current === own) reads.current = null }
  }, [waitMs, paced])
  return useCallback((key: string, read: Read<T> | null, waitMs?: number) => reads.current?.ask(key, read, waitMs), [])
}

// A dialog's preview, read as its form changes (lib/typedReads.ts): the newest answer stays on screen while the
// next one loads, so the table doesn't flicker; a failed one is cleared with the server's reason. `typed` picks the
// fields typed into: a change to one waits the typing wait; any other change (a pick) and the first read go at
// once. Without it, every field is typed into.
export interface PreviewState<R> {
  loading: boolean
  result: R | null
  error: string | null
}

const IDLE = { loading: false, result: null, error: null }

export function usePreviewRead<B, R>(
  sheetId: string, body: B | null, preview: (sheetId: string, body: B, signal: AbortSignal) => Promise<R>,
  fallback: string, typed?: (body: B) => unknown,
): PreviewState<R> {
  const [state, setState] = useState<PreviewState<R>>(IDLE)
  const key = body ? JSON.stringify(body) : ''
  const typedKey = body && typed ? JSON.stringify(typed(body)) : null
  const last = useRef<string | null | undefined>(undefined)
  const ask = useTypedReads<R>(a => setState(a.ok ? { loading: false, result: a.value, error: null }
    : { loading: false, result: null, error: readError(a.error, fallback) }))
  useEffect(() => {
    const before = last.current
    last.current = key ? typedKey : undefined
    if (!key) { setState(IDLE); ask('', null); return }
    setState(s => ({ ...s, loading: true }))
    const picked = typed !== undefined && (before === undefined || before === typedKey)
    ask(`${sheetId}\n${key}`, signal => preview(sheetId, JSON.parse(key) as B, signal), picked ? 0 : undefined)
  }, [sheetId, key, ask]) // eslint-disable-line react-hooks/exhaustive-deps
  return state
}
