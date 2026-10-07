import { useEffect, useState } from 'react'
import {
  enrichAPI, type EnrichSheetSetup, type EnrichToolAccess, type EnrichToolDetail, type TregBalance,
} from '@/utils/api'

// Tool details for this page session (the server caches treg's catalog too).
const tools = new Map<string, EnrichToolDetail>()

interface SetupData {
  tool: EnrichToolDetail | null
  toolError: string | null
  access: EnrichToolAccess | null
  setup: EnrichSheetSetup | null
  balance: TregBalance | null
}

// What Set up reads for the picked tool: its details, how the team's treg
// key is served for it (own keys, free routes), the sheet's row counts and
// room for columns, and the treg balance. The last three are best effort:
// Set up still works without them, it just says less.
export function useSetupData(sheetId: string, toolId: string | null, hasKey: boolean | undefined, active: boolean) {
  const [data, setData] = useState<SetupData>({ tool: null, toolError: null, access: null, setup: null, balance: null })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!active || !toolId) return
    const cached = tools.get(toolId)
    if (cached) { setData(d => ({ ...d, tool: cached, toolError: null })); return }
    let alive = true
    setData(d => ({ ...d, tool: null, toolError: null }))
    enrichAPI.tool(toolId)
      .then(tool => { tools.set(toolId, tool); if (alive) setData(d => ({ ...d, tool })) })
      .catch(err => {
        if (alive) setData(d => ({ ...d, toolError: err?.response?.data?.error || "Couldn't load this enrichment. Try again." }))
      })
    return () => { alive = false }
  }, [toolId, active, attempt])

  useEffect(() => {
    if (!active || !toolId || !hasKey) { setData(d => ({ ...d, access: null })); return }
    let alive = true
    enrichAPI.access(toolId).then(access => { if (alive) setData(d => ({ ...d, access })) }).catch(() => {})
    return () => { alive = false }
  }, [toolId, hasKey, active])

  // Row counts and the balance can change between opens: read them each time.
  useEffect(() => {
    if (!active) return
    let alive = true
    enrichAPI.sheetSetup(sheetId).then(setup => { if (alive) setData(d => ({ ...d, setup })) }).catch(() => {})
    return () => { alive = false }
  }, [sheetId, active])

  useEffect(() => {
    if (!active || !hasKey) { setData(d => ({ ...d, balance: null })); return }
    let alive = true
    enrichAPI.balance().then(balance => { if (alive) setData(d => ({ ...d, balance })) }).catch(() => {})
    return () => { alive = false }
  }, [hasKey, active])

  return { ...data, retryTool: () => setAttempt(a => a + 1) }
}
