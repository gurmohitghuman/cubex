import { useEffect, useState } from 'react'
import { usageAPI, type UsageAsk, type UsageReport } from '@/utils/api'

// The Usage view's report for a sheet and a choice of range and grouping,
// read again when either changes. ask null: nothing to read (closed, or a
// custom range still being picked).
export function useUsage(sheetId: string | null, ask: UsageAsk | null) {
  const [report, setReport] = useState<UsageReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const key = sheetId && ask ? JSON.stringify([sheetId, ask]) : ''

  useEffect(() => {
    if (!key || !sheetId || !ask) { setLoading(false); return }
    const ctrl = new AbortController()
    setLoading(true)
    setError(null)
    usageAPI.read(sheetId, ask, ctrl.signal)
      .then(r => { if (!ctrl.signal.aborted) { setReport(r); setLoading(false) } })
      .catch(e => {
        if (ctrl.signal.aborted) return
        setError(e?.response?.data?.error || "Couldn't read the usage right now.")
        setLoading(false)
      })
    return () => ctrl.abort()
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  return { report, error, loading }
}
