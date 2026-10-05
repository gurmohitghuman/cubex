import React, { useState } from 'react'
import { Loader2, Sparkles, Wrench } from 'lucide-react'
import { httpAPI } from '@/utils/api'
import { OpenRouterCreditNotice } from '../OpenRouterCreditNotice'
import { HTTPAPIConfig, HTTPPreview } from './types'

interface Props {
  sheetId: string
  config: HTTPAPIConfig
  previewResults: HTTPPreview[]
  // When the AI proposes a corrected config, the parent merges it into state
  // and re-runs preview so the user sees whether the fix worked.
  onApplyFix: (next: HTTPAPIConfig) => Promise<void> | void
}

// Surfaces an "Ask AI to fix this" panel when every preview row failed.
// Sends the failed request shape + the upstream error response back to the
// model and applies the suggested config on confirm. Only the model's
// one-sentence explanation is shown to the user — the diff is implicit in
// the form fields updating beneath them.
export const PreviewErrorTroubleshoot: React.FC<Props> = ({
  sheetId, config, previewResults, onApplyFix,
}) => {
  const [loading, setLoading] = useState(false)
  const [proposed, setProposed] = useState<HTTPAPIConfig | null>(null)
  const [explanation, setExplanation] = useState<string>('')
  // Inline (not a toast): assist failures — e.g. "No AI model set" — need to
  // stay on screen next to the button they block, not vanish after 4s.
  const [askError, setAskError] = useState<string | null>(null)

  // Only count rows that actually represent a request attempt — the server
  // may include synthetic rows (rowIndex < 0) for examples / placeholders.
  // And we only show the troubleshoot panel when EVERY real attempt failed,
  // so a partial-success preview isn't flagged as broken.
  const realResults = previewResults.filter(r => r.rowIndex >= 0)
  const hasAnySuccess = realResults.some(r => r.status === 'success')
  const errorSamples = hasAnySuccess
    ? []
    : realResults
      .filter(r => r.status === 'error' && r.error)
      .slice(0, 3)
      .map(r => r.error)

  // Detect "this is an auth problem, not a config problem" before bothering
  // the AI. If every error is 401/403 AND the request already uses the
  // standard Authorization: Bearer header shape, the key is the problem and
  // the AI will only break things by inventing config changes. Short-circuit
  // and tell the user directly. (RapidAPI / X-API-Key shapes get the AI loop
  // since they're more likely to be config-fixable.)
  const looksLikeAuthFailureOnly = errorSamples.length > 0 && errorSamples.every(e =>
    typeof e === 'string' && /\b(401|403)\b|unauthori[sz]ed|not authenticated|invalid (api )?key/i.test(e),
  )
  const usesBearerAuth = (config.headers ?? []).some(h =>
    h.key?.toLowerCase() === 'authorization' && /^bearer\s/i.test(h.value || ''),
  )
  const authProblem = looksLikeAuthFailureOnly && usesBearerAuth

  const askAI = async () => {
    setLoading(true)
    setAskError(null)
    try {
      const result = await httpAPI.troubleshootConfig({
        sheetId,
        currentConfig: config,
        errorSamples,
      })
      setProposed(result.config as HTTPAPIConfig)
      setExplanation(result.explanation)
    } catch (e: any) {
      setAskError(e?.response?.data?.error || 'AI could not suggest a fix')
    } finally {
      setLoading(false)
    }
  }

  const accept = async () => {
    if (!proposed) return
    setProposed(null); setExplanation('')
    await onApplyFix(proposed)
  }

  const dismiss = () => { setProposed(null); setExplanation('') }

  if (errorSamples.length === 0) return null

  return (
    <div className="border border-red-300 bg-red-50 p-3 space-y-3">
      <div className="flex items-start gap-2">
        <Wrench className="h-4 w-4 text-red-700 mt-0.5 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-red-800">All preview rows failed</div>
          <div className="text-xs text-red-700 mt-1">{truncate(errorSamples[0] || '', 200)}</div>
        </div>
      </div>

      {!proposed && authProblem && (
        <div className="bg-white border border-red-200 p-3 text-sm text-gray-800 space-y-2">
          <div>
            <span className="font-medium">This looks like an API key problem, not a config problem.</span>
            {' '}The endpoint is reachable and the request shape is standard <code className="bg-gray-100 px-1 text-xs">Authorization: Bearer …</code>, so the upstream is rejecting your key value.
          </div>
          <div className="text-xs text-gray-600">
            Double-check the key in the AI assist bar above: make sure it's the right one for this URL (sandbox vs. production, or per-instance keys), and not expired. If you'd still like the AI to suggest a config tweak, click below.
          </div>
          <div className="flex items-center justify-end gap-2">
            <OpenRouterCreditNotice neutralOnly />
            <button
              onClick={askAI}
              disabled={loading}
              className="btn-secondary flex items-center gap-2 text-sm"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              <span>{loading ? 'AI is looking…' : 'Ask AI anyway'}</span>
            </button>
          </div>
        </div>
      )}

      {!proposed && !authProblem && (
        <div className="flex items-center justify-end gap-2">
          <OpenRouterCreditNotice />
          <button
            onClick={askAI}
            disabled={loading}
            className="btn-primary flex items-center gap-2 text-sm"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            <span>{loading ? 'AI is looking…' : 'Ask AI to fix this'}</span>
          </button>
        </div>
      )}

      {askError && <div className="p-2 bg-cube-black text-xs text-white">{askError}</div>}

      {proposed && (
        <div className="bg-white border border-red-200 p-3 space-y-2">
          <div className="text-sm text-gray-800">
            <span className="font-medium">AI suggests:</span> {explanation}
          </div>
          <ChangesList before={config} after={proposed} />
          <div className="flex justify-end gap-2">
            <button onClick={dismiss} className="btn-secondary text-sm">Ignore</button>
            <button onClick={accept} className="btn-primary flex items-center gap-2 text-sm">
              <Sparkles className="h-4 w-4" />
              <span>Apply fix and try again</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…'
}

// Show what the AI is actually proposing to change before the user accepts.
// Without this, repeated "Apply fix and try again" cycles silently mutate the
// form and the user can't tell when the AI has drifted (e.g. broken a working
// URL while trying to fix a 401). Compares the load-bearing fields and lists
// any non-trivial diffs in plain English.
function ChangesList({ before, after }: { before: HTTPAPIConfig; after: HTTPAPIConfig }) {
  const changes: string[] = []
  if (before.method !== after.method) changes.push(`Method: ${before.method} → ${after.method}`)
  if (before.endpointUrl !== after.endpointUrl) {
    changes.push(`URL: ${truncate(before.endpointUrl, 40)} → ${truncate(after.endpointUrl, 40)}`)
  }
  const beforeHeaders = (before.headers ?? []).map(h => `${h.key}: ${h.value}`).sort().join('|')
  const afterHeaders = (after.headers ?? []).map(h => `${h.key}: ${h.value}`).sort().join('|')
  if (beforeHeaders !== afterHeaders) changes.push('Headers updated')
  if ((before.body || '') !== (after.body || '')) changes.push('Body updated')
  const beforeMapping = (before.responseMapping ?? []).length
  const afterMapping = (after.responseMapping ?? []).length
  if (beforeMapping !== afterMapping) {
    changes.push(`Response fields: ${beforeMapping} → ${afterMapping}`)
  }

  if (changes.length === 0) {
    return <div className="text-xs text-gray-500">(No structural changes. AI is just retrying the same request.)</div>
  }
  return (
    <ul className="text-xs text-gray-700 list-disc pl-5 space-y-0.5">
      {changes.map((c, i) => <li key={i}>{c}</li>)}
    </ul>
  )
}
