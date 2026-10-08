import { useCallback, useMemo, useState } from 'react'
import { aiAPI, httpAPI, AIRun, HTTPRun } from '@/utils/api'
import { structuredRunColumns } from '@/lib/structuredRuns'

type RunByColumn = Record<string, { runId: string; status: 'running' | 'paused' | 'pending' }>

export const useActiveRuns = () => {
  const [httpRuns, setHttpRuns] = useState<HTTPRun[]>([])
  const [aiRuns, setAiRuns] = useState<AIRun[]>([] as any)
  // Every column a structured (multi-column) AI run writes, finished runs too.
  // Such a run is set up over MCP or the API; the column menu doesn't offer
  // "Edit / Update Instructions" on its columns (the dialog is single-column).
  const [aiStructuredColumns, setAiStructuredColumns] = useState<ReadonlySet<string>>(new Set())

  const fetchHTTPRuns = useCallback(async (sheetId: string) => {
    try {
      const runs = await httpAPI.getRuns(sheetId)
      const active = runs.filter(r => r.status === 'running' || r.status === 'paused' || r.status === 'pending')
      setHttpRuns(active)
      return active
    } catch (error) {
      console.error('Error fetching active HTTP runs:', error)
      return []
    }
  }, [])

  const fetchAIRuns = useCallback(async (sheetId: string) => {
    try {
      const runs = await aiAPI.getRuns(sheetId)
      const active = runs.filter(r => r.status === 'running' || r.status === 'paused' || r.status === 'pending')
      setAiRuns(active)
      setAiStructuredColumns(new Set(runs.flatMap(structuredRunColumns)))
      return active
    } catch (error) {
      console.error('Error fetching active AI runs:', error)
      return []
    }
  }, [])

  const refetch = useCallback(async (sheetId: string) => {
    await Promise.allSettled([fetchHTTPRuns(sheetId), fetchAIRuns(sheetId)])
  }, [fetchHTTPRuns, fetchAIRuns])

  const httpByColumn = useMemo(() => {
    const m: RunByColumn = {}
    httpRuns.forEach(r => {
      if (r.master_column_name) m[r.master_column_name] = { runId: r.id, status: r.status as any }
    })
    return m
  }, [httpRuns])

  const aiByColumn = useMemo(() => {
    const m: RunByColumn = {}
    aiRuns.forEach(r => {
      const run = { runId: r.id, status: r.status as any }
      m[r.column_name] = run
      // A structured run writes several columns, and each of them shows it.
      for (const c of structuredRunColumns(r)) m[c] = run
    })
    return m
  }, [aiRuns])

  return {
    httpRuns,
    aiRuns,
    setHttpRuns,
    setAiRuns,
    fetchHTTPRuns,
    fetchAIRuns,
    refetch,
    httpByColumn,
    aiByColumn,
    aiStructuredColumns,
  }
}
