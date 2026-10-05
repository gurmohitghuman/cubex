import { useEffect, useMemo, useState } from 'react'
import { OpenRouterModel, settingsAPI } from '@/utils/api'

// Grouped handle so consumers thread ONE prop instead of nine.
export type ModelsHandle = ReturnType<typeof useModels>

export const useModels = (isOpen: boolean, model: string) => {
  const [availableModels, setAvailableModels] = useState<OpenRouterModel[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [modelSearch, setModelSearch] = useState('')
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false)

  const loadModels = async () => {
    if (availableModels.length > 0) return // already loaded this session
    setModelsLoading(true); setModelsError(null)
    try {
      setAvailableModels(await settingsAPI.listOpenRouterModels())
    } catch (error) {
      console.error('Failed to load OpenRouter models:', error)
      setModelsError('Failed to load models. Check your network and try again.')
    } finally {
      setModelsLoading(false)
    }
  }

  useEffect(() => { if (isOpen) loadModels() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [isOpen])

  const filteredModels = useMemo(() => {
    const q = modelSearch.trim().toLowerCase()
    if (!q) return availableModels
    return availableModels.filter(m => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
  }, [availableModels, modelSearch])

  const selectedModel = useMemo(() => availableModels.find(m => m.id === model), [availableModels, model])

  return {
    availableModels, modelsLoading, modelsError, loadModels,
    modelSearch, setModelSearch, modelDropdownOpen, setModelDropdownOpen,
    filteredModels, selectedModel,
  }
}
