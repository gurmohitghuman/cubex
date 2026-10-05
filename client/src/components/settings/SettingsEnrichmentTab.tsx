import React, { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { APIKey, settingsAPI } from '@/utils/api'
import { ApiKeysSection } from './ApiKeysSection'
import { TabLoading, TabLoadFailed } from './TabLoading'

// Saved third-party credentials for HTTP enrichment templates (/key_name).
// Deliberately a separate tab from Agent access: these are NOT Cubex
// credentials, and the old side-by-side layout invited exactly that mix-up.
// The explicit loading/failure states also fix
// the old page's false "No keys yet" flash while the list was still fetching.
export const SettingsEnrichmentTab: React.FC = () => {
  const [apiKeys, setApiKeys] = useState<APIKey[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)

  const loadAPIKeys = async () => {
    try {
      setApiKeys(await settingsAPI.getAPIKeys())
      setLoadFailed(false)
    } catch (error) {
      toast.error('Failed to load saved keys')
      console.error('Load API keys error:', error)
      setLoadFailed(true)
    }
  }
  useEffect(() => { loadAPIKeys() }, [])

  if (apiKeys === null) {
    return loadFailed ? <TabLoadFailed what="saved keys" onRetry={loadAPIKeys} /> : <TabLoading />
  }
  return <ApiKeysSection apiKeys={apiKeys} reloadAPIKeys={loadAPIKeys} />
}
