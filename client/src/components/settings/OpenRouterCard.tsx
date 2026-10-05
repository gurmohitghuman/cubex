import React, { useState } from 'react'
import { AlertTriangle, Check, ExternalLink, Eye, EyeOff, Loader2, Save, Trash2, X } from 'lucide-react'
import toast from 'react-hot-toast'
import { Settings, settingsAPI } from '@/utils/api'
import { OpenRouterLogo } from '@/components/OpenRouterLogo'

interface OpenRouterCardProps {
  settings: Settings | null
  reloadSettings: () => Promise<void>
}

export const OpenRouterCard: React.FC<OpenRouterCardProps> = ({ settings, reloadSettings }) => {
  const [apiKey, setApiKey] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [isTestingKey, setIsTestingKey] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isClearing, setIsClearing] = useState(false)
  const [testResult, setTestResult] = useState<{ valid: boolean; message: string } | null>(null)
  const [credits, setCredits] = useState<{ usage?: number; limit: number | null; balance?: number } | null>(null)

  const handleTest = async () => {
    if (!apiKey.trim()) { toast.error('Please enter an API key to test'); return }
    setIsTestingKey(true); setTestResult(null); setCredits(null)
    try {
      const result = await settingsAPI.testOpenRouterKey(apiKey.trim())
      setTestResult({ valid: result.valid, message: result.message })
      if (result.credits) setCredits({ usage: result.credits.usage, limit: result.credits.limit, balance: result.credits.balance })
      if (result.valid) toast.success(result.message); else toast.error(result.message)
    } catch {
      toast.error('Failed to test API key')
      setTestResult({ valid: false, message: 'Failed to test API key' })
    } finally { setIsTestingKey(false) }
  }

  const handleSave = async () => {
    if (!apiKey.trim()) { toast.error('Please enter an API key'); return }
    setIsSaving(true)
    try {
      await settingsAPI.updateOpenRouterKey(apiKey.trim())
      await reloadSettings()
      setApiKey(''); setTestResult(null); setCredits(null)
      toast.success('OpenRouter API key saved successfully')
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Failed to save API key')
    } finally { setIsSaving(false) }
  }

  const handleClear = async () => {
    setIsClearing(true)
    try {
      await settingsAPI.clearOpenRouterKey()
      await reloadSettings()
      setApiKey(''); setTestResult(null); setCredits(null)
      // No success toast — the field empties and the 'configured' status
      // disappears, which is immediately visible.
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Failed to clear API key')
    } finally { setIsClearing(false) }
  }

  return (
    <div className="card mb-6">
      <div className="p-6 border-b border-gray-200">
        <div className="flex items-center space-x-3">
          <OpenRouterLogo className="h-9 w-9 rounded-sm" />
          <div>
            <h3 className="text-title text-gray-900">OpenRouter API Key</h3>
            <p className="text-sm text-gray-600">
              Required for AI Column. One key gives access to 300+ models from every major provider.
            </p>
          </div>
        </div>
      </div>

      <div className="p-6">
        <div className="mb-6">
          <div className="flex items-center space-x-2 mb-2">
            <span className="text-sm font-medium text-gray-700">Current Status:</span>
            {settings?.hasOpenRouterKey ? (
              <div className="flex items-center space-x-1 text-cube-black"><Check className="h-4 w-4" /><span className="text-sm">API key configured</span></div>
            ) : (
              <div className="flex items-center space-x-1 text-cube-black"><X className="h-4 w-4" /><span className="text-sm">No API key configured</span></div>
            )}
          </div>

          {!settings?.hasOpenRouterKey && (
            <div className="bg-white border border-cube-black rounded-sm p-4 mb-4">
              <div className="flex items-start space-x-2">
                <AlertTriangle className="h-5 w-5 text-cube-black flex-shrink-0 mt-0.5" />
                <div>
                  <h4 className="text-sm font-medium text-cube-black">API Key Required</h4>
                  <p className="text-sm text-cube-black mt-1">
                    You need an OpenRouter API key to use the AI Column feature. OpenRouter gives you access to
                    GPT, Claude, Gemini, Llama and 300+ other models with one key.
                  </p>
                  <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center space-x-1 text-sm text-cube-black underline hover:no-underline mt-2">
                    <span>Get API Key</span><ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div>
            <label htmlFor="apiKey" className="block text-sm font-medium text-gray-700 mb-2">
              {settings?.hasOpenRouterKey ? 'Update API Key' : 'Enter OpenRouter API Key'}
            </label>
            <div className="relative">
              <input id="apiKey" type={showApiKey ? 'text' : 'password'} className="input w-full pr-20"
                placeholder="sk-..." value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
              <button type="button" onClick={() => setShowApiKey(!showApiKey)} className="absolute right-12 top-2.5 text-gray-400 hover:text-gray-600">
                {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <p className="text-xs text-gray-500 mt-1">Your API key is encrypted at rest and never shared</p>
          </div>

          {testResult && (
            <div className={`p-3 rounded-sm ${testResult.valid ? 'bg-gray-100 border border-cube-black' : 'bg-white border border-cube-black'}`}>
              <div className="flex items-center space-x-2">
                {testResult.valid ? <Check className="h-4 w-4 text-cube-black" /> : <X className="h-4 w-4 text-cube-black" />}
                <span className="text-sm text-cube-black">{testResult.message}</span>
              </div>
              {credits && (() => {
                // Build the detail line from whichever figures the API actually
                // returned — each is independently optional, so a missing piece
                // is dropped rather than shown as a fabricated $0.
                const parts: string[] = []
                if (typeof credits.balance === 'number') parts.push(`Balance: $${credits.balance.toFixed(2)}`)
                if (typeof credits.usage === 'number') parts.push(`Spent on this key: $${credits.usage.toFixed(4)}`)
                if (credits.limit !== null) parts.push(`Key limit: $${credits.limit.toFixed(2)}`)
                return parts.length ? <p className="text-xs text-gray-600 mt-1 ml-6">{parts.join(' · ')}</p> : null
              })()}
            </div>
          )}

          <div className="flex space-x-3">
            <button onClick={handleTest} disabled={isTestingKey || !apiKey.trim()} className="btn-secondary flex items-center space-x-2">
              {isTestingKey ? <Loader2 className="h-4 w-4 animate-spin text-gray-500" /> : <Check className="h-4 w-4" />}
              <span>Test Key</span>
            </button>
            <button onClick={handleSave} disabled={isSaving || !apiKey.trim()} className="btn-primary flex items-center space-x-2">
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin text-white" /> : <Save className="h-4 w-4" />}
              <span>Save Key</span>
            </button>
            {settings?.hasOpenRouterKey && (
              <button onClick={handleClear} disabled={isClearing} className="btn-danger flex items-center space-x-2">
                {isClearing ? <Loader2 className="h-4 w-4 animate-spin text-white" /> : <Trash2 className="h-4 w-4" />}
                <span>Clear Key</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
