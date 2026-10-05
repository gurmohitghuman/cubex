import React from 'react'
import { Slider } from '@/components/ui/slider'
import { HTTPAPIConfig } from './types'
import { plural } from '@/lib/utils'

interface Props {
  config: HTTPAPIConfig
  updateConfig: (updates: Partial<HTTPAPIConfig>) => void
}

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
          max={20} min={1} step={1} className="w-full" />
        <div className="flex justify-between text-xs text-gray-500 mt-1">
          <span>1 (Slow)</span><span>20 (Fast)</span>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Rate Limit (req/sec)</label>
        <input type="number" className="input w-full" placeholder="No limit"
          value={config.rateLimit || ''}
          onChange={(e) => updateConfig({ rateLimit: e.target.value ? Number(e.target.value) : undefined })} />
        <p className="text-xs text-gray-500 mt-1">Leave empty for no rate limiting</p>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Retries: {config.retries}
        </label>
        <input type="range" min="0" max="5" step="1" className="w-full"
          value={config.retries}
          onChange={(e) => updateConfig({ retries: Number(e.target.value) })} />
      </div>
    </div>
  </div>
)
