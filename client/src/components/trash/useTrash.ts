import { useCallback, useEffect, useRef, useState } from 'react'
import { trashAPI, type TrashEntry, type TrashKind } from '@/utils/api'

// The Trash page's list: newest first, searched as you type (q), narrowed by
// kind, a page at a time ("Load more"). While something is being restored or
// deleted for good, it looks again every few seconds to show it moving on.
export function useTrash() {
  const [q, setQ] = useState('')
  const [kind, setKind] = useState<TrashKind | ''>('')
  const [items, setItems] = useState<TrashEntry[]>([])
  const [days, setDays] = useState<number | null>(null)
  const [totalBytes, setTotalBytes] = useState(0)
  const [next, setNext] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const ask = useRef(0)

  // A new search starts over; a refresh (tick) keeps the pages loaded below the first.
  const lastAsk = useRef('')
  useEffect(() => {
    const ctl = new AbortController()
    const n = ++ask.current
    const key = `${q.trim()}|${kind}`
    const fresh = key !== lastAsk.current
    lastAsk.current = key
    const wait = setTimeout(() => {
      setLoading(true)
      trashAPI.list({ q: q.trim() || undefined, kind: kind || undefined }, ctl.signal)
        .then(list => {
          if (n !== ask.current) return
          const oldest = list.items.length ? list.items[list.items.length - 1].id : 0
          setItems(prev => (fresh || list.next_before === null ? list.items
            : [...list.items, ...prev.filter(i => i.id < oldest)]))
          if (fresh || list.next_before === null) setNext(list.next_before)
          setDays(list.kept_days); setTotalBytes(list.total_bytes); setError(null)
        })
        .catch(e => { if (!ctl.signal.aborted) setError(e?.response?.data?.error || "Couldn't read the trash") })
        .finally(() => { if (n === ask.current) setLoading(false) })
    }, q ? 250 : 0)
    return () => { clearTimeout(wait); ctl.abort() }
  }, [q, kind, tick])

  const moving = items.some(i => i.state === 'restoring' || i.state === 'purging' || i.state === 'moving')
  useEffect(() => {
    if (!moving) return
    const t = setTimeout(() => setTick(x => x + 1), 3000)
    return () => clearTimeout(t)
  }, [moving, items])

  const reload = useCallback(() => setTick(x => x + 1), [])
  const loadMore = useCallback(async () => {
    if (next === null) return
    const n = ask.current
    const list = await trashAPI.list({ q: q.trim() || undefined, kind: kind || undefined, before: next })
    if (n !== ask.current) return // the search changed meanwhile
    setItems(prev => [...prev, ...list.items.filter(i => !prev.some(p => p.id === i.id))])
    setNext(list.next_before)
  }, [next, q, kind])

  return { q, setQ, kind, setKind, items, days, totalBytes, hasMore: next !== null, loading, error, reload, loadMore }
}
