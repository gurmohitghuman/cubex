import React, { useState } from 'react'
import { AlertTriangle, Check, DatabaseZap, ExternalLink, Eye, EyeOff, Loader2, Save, Trash2, X } from 'lucide-react'
import toast from 'react-hot-toast'
import { Settings, settingsAPI } from '@/utils/api'
import { TREG_APP_URL, TREG_TOPUP_URL } from '@/lib/enrich-format'
import { DailyLimitControl } from './DailyLimitControl'

interface TregCardProps {
  settings: Settings
  reloadSettings: () => Promise<void>
}

const ExtLink: React.FC<{ href: string; children: React.ReactNode }> = ({ href, children }) => (
  <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline hover:no-underline">
    <span>{children}</span><ExternalLink className="h-3 w-3" />
  </a>
)

// Settings → Enrichment: the user's own treg key (like the OpenRouter key) and
// the daily limit for everything enrichments spend.
export const TregCard: React.FC<TregCardProps> = ({ settings, reloadSettings }) => {
  const [apiKey, setApiKey] = useState('')
  const [show, setShow] = useState(false)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [testResult, setTestResult] = useState<{ valid: boolean; message: string } | null>(null)

  // Tests the typed key, or the saved one when the field is empty.
  const handleTest = async () => {
    setTesting(true); setTestResult(null)
    try {
      const result = await settingsAPI.testTregKey(apiKey.trim() || undefined)
      setTestResult({ valid: result.valid, message: result.message })
      if (!result.valid) toast.error(result.message)
    } catch (error: any) {
      const message = error.response?.data?.error || 'Failed to test the treg key'
      setTestResult({ valid: false, message }); toast.error(message)
    } finally { setTesting(false) }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await settingsAPI.updateTregKey(apiKey.trim())
      await reloadSettings()
      setApiKey('')
      // Show what treg says about the saved key right away.
      const result = await settingsAPI.testTregKey()
      setTestResult({ valid: result.valid, message: result.message })
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Failed to save the treg key')
    } finally { setSaving(false) }
  }

  const handleClear = async () => {
    setClearing(true)
    try {
      await settingsAPI.clearTregKey()
      await reloadSettings()
      setApiKey(''); setTestResult(null)
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Failed to clear the treg key')
    } finally { setClearing(false) }
  }

  const hasKey = settings.hasTregKey

  return (
    <div className="card mb-6" data-testid="treg-card">
      <div className="p-6 border-b border-gray-200">
        <div className="flex items-center space-x-3">
          <div className="bg-cube-black p-2 rounded-sm"><DatabaseZap className="h-5 w-5 text-white" /></div>
          <div>
            <h3 className="text-title text-gray-900">treg API key</h3>
            <p className="text-sm text-gray-600">
              Runs enrichments: work emails, phones, company and person data from 100+ providers, billed by treg from your prepaid balance.
            </p>
          </div>
        </div>
      </div>

      <div className="p-6 space-y-4">
        <div className="flex items-center space-x-2">
          <span className="text-sm font-medium text-gray-700">Current Status:</span>
          <div className="flex items-center space-x-1 text-cube-black">
            {hasKey ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}
            <span className="text-sm">{hasKey ? 'Key configured' : 'No key configured'}</span>
          </div>
        </div>

        {!hasKey && (
          <div className="bg-white border border-cube-black rounded-sm p-4">
            <div className="flex items-start space-x-2">
              <AlertTriangle className="h-5 w-5 text-cube-black flex-shrink-0 mt-0.5" />
              <div className="text-sm text-cube-black space-y-1">
                <h4 className="font-medium">treg key required</h4>
                <p>You need a treg key to run enrichments. In treg, open your team, then API keys, then Create key. A login token from <code>treg login</code> won't work.</p>
                <ExtLink href={TREG_APP_URL}>Get a key</ExtLink>
              </div>
            </div>
          </div>
        )}

        <div>
          <label htmlFor="tregKey" className="block text-sm font-medium text-gray-700 mb-2">
            {hasKey ? 'Update treg key' : 'Enter treg key'}
          </label>
          <div className="relative">
            <input id="tregKey" type={show ? 'text' : 'password'} className="input w-full pr-12" placeholder="treg_..."
              value={apiKey} onChange={e => setApiKey(e.target.value)} autoComplete="off" />
            <button type="button" onClick={() => setShow(!show)} aria-label={show ? 'Hide key' : 'Show key'}
              className="absolute right-3 top-2.5 text-gray-400 hover:text-gray-600">
              {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          <p className="text-xs text-gray-500 mt-1">Encrypted at rest. Cubex only ever sends it to treg.</p>
        </div>

        {testResult && (
          <div className={`p-3 rounded-sm border border-cube-black ${testResult.valid ? 'bg-gray-100' : 'bg-white'}`} data-testid="treg-test-result">
            <div className="flex items-center space-x-2">
              {testResult.valid ? <Check className="h-4 w-4 text-cube-black" /> : <X className="h-4 w-4 text-cube-black" />}
              <span className="text-sm text-cube-black">{testResult.message}</span>
            </div>
          </div>
        )}

        <div className="flex space-x-3">
          <button onClick={handleTest} disabled={testing || (!apiKey.trim() && !hasKey)} className="btn-secondary flex items-center space-x-2">
            {testing ? <Loader2 className="h-4 w-4 animate-spin text-gray-500" /> : <Check className="h-4 w-4" />}
            <span>Test Key</span>
          </button>
          <button onClick={handleSave} disabled={saving || !apiKey.trim()} className="btn-primary flex items-center space-x-2">
            {saving ? <Loader2 className="h-4 w-4 animate-spin text-white" /> : <Save className="h-4 w-4" />}
            <span>Save Key</span>
          </button>
          {hasKey && (
            <button onClick={handleClear} disabled={clearing} className="btn-danger flex items-center space-x-2">
              {clearing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              <span>Clear Key</span>
            </button>
          )}
        </div>

        <DailyLimitControl limit={settings.enrichDailyLimit} onChanged={reloadSettings} />

        <p className="text-xs text-gray-600 flex flex-wrap gap-x-3 gap-y-1">
          <ExtLink href={TREG_TOPUP_URL}>Top up</ExtLink>
          <span>
            <ExtLink href={TREG_APP_URL}>Use your own provider keys at treg</ExtLink>
            {' '}(those calls don't use your treg balance)
          </span>
        </p>
      </div>
    </div>
  )
}
