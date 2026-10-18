import React from 'react'
import { Slider } from '@/components/ui/slider'
import { HTTPAPIConfig } from './types'
import { plural } from '@/lib/utils'
import { HTTP_MAX_CONCURRENCY, HTTP_RETRY_MAX } from '@/lib/constants'

interface Props {
  config: HTTPAPIConfig
  updateConfig: (updates: Partial<HTTPAPIConfig>) => void
}

interface CheckProps { checked: boolean; onChange: (v: boolean) => void; label: string; hint: string; testId: string }
const Check: React.FC<CheckProps> = ({ checked, onChange, label, hint, testId }) => (
  <label className="flex items-start gap-2">
    <input type="checkbox" className="mt-0.5" checked={checked} data-testid={testId}
      onChange={(e) => onChange(e.target.checked)} />
    <span className="text-sm">
      <span className="text-gray-700">{label}</span>
      <span className="block text-xs text-gray-500">{hint}</span>
    </span>
  </label>
)

export const SettingsPane: React.FC<Props> = ({ config, updateConfig }) => (
  <div className="space-y-4">
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Preview Size: {config.previewSize} rows
        </label>
        <Slider value={[config.previewSize]} onValueChange={(value) => updateConfig({ previewSize: value[0] })}
          max={20} min={3} step={1} className="w-full" />
        <div className="flex justify-between text-xs text-gray-500 mt-1">
          <span>3 rows</span><span>20 rows</span>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Concurrency: {plural(config.concurrency, 'request')}
        </label>
        <Slider value={[config.concurrency]} onValueChange={(value) => updateConfig({ concurrency: value[0] })}
          max={HTTP_MAX_CONCURRENCY} min={1} step={1} className="w-full" />
        <div className="flex justify-between text-xs text-gray-500 mt-1">
          <span>1 (Slow)</span><span>{HTTP_MAX_CONCURRENCY} (Fast)</span>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Retry failed requests: {config.retries === 0 ? 'off' : `up to ${plural(config.retries, 'time')}`}
        </label>
        <input type="range" min="0" max={HTTP_RETRY_MAX} step="1" className="w-full" data-testid="http-retries"
          value={config.retries}
          onChange={(e) => updateConfig({ retries: Number(e.target.value) })} />
        <p className="text-xs text-gray-500 mt-1">
          When the API is busy (429), down (5xx) or doesn&apos;t answer, Cubex waits a little longer each time and
          tries again, following the wait the API asks for (up to a minute). A request it rejects (like a 404) is not
          retried.
        </p>
      </div>

      {config.retries > 0 && (
        <Check testId="http-retry-post" checked={config.retryPost}
          onChange={(retryPost) => updateConfig({ retryPost })}
          label="Also retry POST requests"
          hint={'Only if sending the same request twice is safe for this API. Busy (429) and unavailable (503) '
            + 'answers are always retried.'} />
      )}

      <Check testId="http-skip-empty" checked={config.skipEmpty} onChange={(skipEmpty) => updateConfig({ skipEmpty })}
        label="Leave out empty values"
        hint={'A query parameter or body field whose {{column}} is empty for a row isn\'t sent, instead of being '
          + 'sent empty.'} />
    </div>
  </div>
)
