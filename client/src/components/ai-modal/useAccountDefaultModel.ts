import { useEffect, useState } from 'react'
import { settingsAPI } from '@/utils/api'

// The account-wide default AI model (Settings → Default AI model), fetched
// once per modal open. Feeds the modal's hydration fallback: draft/explicit >
// sheet default > THIS > none. undefined = still loading OR fetch failed (a
// warning banner must stay silent unless we KNOW none is set); null = fetched,
// none set. Either falsy value makes the modal require an explicit pick — it
// never invents a model.
export function useAccountDefaultModel(isOpen: boolean): string | null | undefined {
  const [accountDefault, setAccountDefault] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    if (!isOpen) return
    let stale = false
    settingsAPI.get()
      .then(s => { if (!stale) setAccountDefault(s.defaultAiModel ?? null) })
      .catch(() => { /* stays undefined — banner silent, modal requires a pick */ })
    return () => { stale = true }
  }, [isOpen])
  return accountDefault
}
