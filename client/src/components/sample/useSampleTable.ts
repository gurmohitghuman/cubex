import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { tablesAPI } from '@/utils/api'
import type { Table } from '@/utils/api/types'
import { SAMPLE_TABLE_NAME } from '@/lib/constants'

// "Try with sample data" (the dashboard, the New Table dialog): makes the
// sample table on the server and opens its sheet. When the request fails (most
// often the browser giving up after SAMPLE_CREATE_TIMEOUT_MS while the server
// goes on), the tables are read again first: a sample table that wasn't there
// before the click is opened instead of an error, so a retry can't make a second.
const isSampleName = (name: string) => name === SAMPLE_TABLE_NAME || name.startsWith(`${SAMPLE_TABLE_NAME} `)

async function tableIds(): Promise<Set<string> | null> {
  try { return new Set((await tablesAPI.getAll()).map(t => t.id)) } catch { return null }
}

async function madeAnyway(before: Set<string> | null): Promise<Table | null> {
  if (!before) return null
  try {
    return (await tablesAPI.getAll()).find(t => !before.has(t.id) && isSampleName(t.name)) ?? null
  } catch { return null }
}

export function useSampleTable() {
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)

  const createSample = useCallback(async () => {
    if (creating) return // a double click must not make two
    setCreating(true)
    const before = await tableIds()
    try {
      const table = await tablesAPI.createSample()
      navigate(`/table/${table.id}/${table.sheetId}`)
      if (table.problems.length) {
        toast.error(`The sample table is ready, but something didn't finish: ${table.problems[0]}`)
      }
    } catch (e: any) {
      const made = await madeAnyway(before)
      if (made) {
        const sheetId = made.sheets?.[0]?.id
        navigate(sheetId ? `/table/${made.id}/${sheetId}` : `/table/${made.id}`)
        return
      }
      toast.error(e?.response?.data?.error || 'Could not make the sample table.')
      setCreating(false) // on success we navigate away
    }
  }, [navigate, creating])

  return { createSample, creatingSample: creating }
}
