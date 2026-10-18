import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { tablesAPI } from '@/utils/api'

// "Try with sample data" (the dashboard, the New Table dialog): makes the
// sample table on the server and opens its sheet.
export function useSampleTable() {
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)

  const createSample = useCallback(async () => {
    if (creating) return // a double click must not make two
    setCreating(true)
    try {
      const table = await tablesAPI.createSample()
      navigate(`/table/${table.id}/${table.sheetId}`)
      if (table.problems.length) {
        toast.error(`The sample table is ready, but something didn't finish: ${table.problems[0]}`)
      }
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'Could not make the sample table.')
      setCreating(false) // on success we navigate away
    }
  }, [navigate, creating])

  return { createSample, creatingSample: creating }
}
