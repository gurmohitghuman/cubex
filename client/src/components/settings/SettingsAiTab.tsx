import React, { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { Settings, settingsAPI } from '@/utils/api'
import { OpenRouterCard } from './OpenRouterCard'
import { DefaultModelCard } from './DefaultModelCard'
import { TabLoading, TabLoadFailed } from './TabLoading'

// "Make AI columns work": OpenRouter key + account default model — the
// first-run critical path (the dashboard checklist links here).
export const SettingsAiTab: React.FC = () => {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)

  const loadSettings = async () => {
    try {
      setSettings(await settingsAPI.get())
      setLoadFailed(false)
    } catch (error) {
      // Toast covers RELOADS (stale data stays on screen — the user must know
      // the refresh failed); the inline retry below covers the first load.
      toast.error('Failed to load settings')
      console.error('Load settings error:', error)
      setLoadFailed(true)
    }
  }
  useEffect(() => { loadSettings() }, [])

  // Never render the cards with settings === null — that reads as a false
  // "no key / no model configured" state. Spinner while loading,
  // explicit retry on failure; reloads keep the current cards on screen.
  if (settings === null) {
    return loadFailed ? <TabLoadFailed what="AI settings" onRetry={loadSettings} /> : <TabLoading />
  }

  return (
    <>
      <OpenRouterCard settings={settings} reloadSettings={loadSettings} />
      <DefaultModelCard settings={settings} reloadSettings={loadSettings} />
    </>
  )
}
