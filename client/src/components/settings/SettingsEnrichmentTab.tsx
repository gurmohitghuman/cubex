import React, { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { APIKey, Settings, settingsAPI } from '@/utils/api'
import { ApiKeysSection } from './ApiKeysSection'
import { TregCard } from './TregCard'
import { TabLoading, TabLoadFailed } from './TabLoading'

// Enrichment: the treg key that runs enrichments (with the daily limit), then
// the saved third-party credentials HTTP API columns reference as /key_name.
// Deliberately a separate tab from Agent access: none of these are Cubex
// credentials. Explicit loading/failure states avoid a false "no key" flash.
export const SettingsEnrichmentTab: React.FC = () => {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [apiKeys, setApiKeys] = useState<APIKey[] | null>(null)
  // One flag per load: one failing while the other succeeds must still offer Retry.
  const [settingsFailed, setSettingsFailed] = useState(false)
  const [keysFailed, setKeysFailed] = useState(false)

  const loadSettings = async () => {
    try {
      setSettings(await settingsAPI.get())
      setSettingsFailed(false)
    } catch (error) {
      toast.error('Failed to load settings')
      console.error('Load settings error:', error)
      setSettingsFailed(true)
    }
  }

  const loadAPIKeys = async () => {
    try {
      setApiKeys(await settingsAPI.getAPIKeys())
      setKeysFailed(false)
    } catch (error) {
      toast.error('Failed to load saved keys')
      console.error('Load API keys error:', error)
      setKeysFailed(true)
    }
  }

  const retryFailed = () => Promise.all([settingsFailed && loadSettings(), keysFailed && loadAPIKeys()])
  useEffect(() => { loadSettings(); loadAPIKeys() }, [])

  if (settings === null || apiKeys === null) {
    const failed = (settings === null && settingsFailed) || (apiKeys === null && keysFailed)
    return failed ? <TabLoadFailed what="enrichment settings" onRetry={retryFailed} /> : <TabLoading />
  }
  return (
    <>
      <TregCard settings={settings} reloadSettings={loadSettings} />
      <ApiKeysSection apiKeys={apiKeys} reloadAPIKeys={loadAPIKeys} />
    </>
  )
}
