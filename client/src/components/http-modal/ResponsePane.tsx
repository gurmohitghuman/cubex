import React from 'react'
import { Minus, Plus } from 'lucide-react'
import { HTTPAPIConfig } from './types'
import { HTTP_STATUS_PATH } from '@/lib/constants'

interface Props {
  config: HTTPAPIConfig
  // The status column's name, for the response code column's default name.
  masterColumnName: string
  errors: Record<string, string>
  updateConfig: (updates: Partial<HTTPAPIConfig>) => void
  addResponseMapping: () => void
  removeResponseMapping: (i: number) => void
  updateResponseMapping: (i: number, field: 'jsonPath' | 'columnName', value: string) => void
}

const isCode = (m: { jsonPath: string }) => m.jsonPath === HTTP_STATUS_PATH

// The response code column is a mapping of HTTP_STATUS_PATH: it's switched on and
// named here, and stays out of the JSONPath list (whose indexes are kept).
const ResponseCodeField: React.FC<Pick<Props, 'config' | 'masterColumnName' | 'updateConfig'>> = (
  { config, masterColumnName, updateConfig },
) => {
  const code = config.responseMapping.find(isCode)
  const others = config.responseMapping.filter(m => !isCode(m))
  const toggle = (on: boolean) => updateConfig({
    responseMapping: on
      ? [...others, { jsonPath: HTTP_STATUS_PATH, columnName: `${masterColumnName.trim() || 'HTTP'} (Code)` }]
      : others,
  })
  const rename = (columnName: string) => updateConfig({
    responseMapping: config.responseMapping.map(m => (isCode(m) ? { ...m, columnName } : m)),
  })
  return (
    <div>
      <label className="flex items-center space-x-2">
        <input type="checkbox" checked={!!code} data-testid="http-status-code-toggle"
          onChange={(e) => toggle(e.target.checked)}
          className="border-gray-300 text-cube-black focus:ring-cube-black/20" />
        <span className="text-sm text-gray-700">Add a column with the response code</span>
      </label>
      <p className="text-xs text-gray-500 mt-1 ml-6">
        The HTTP status code of each row&apos;s answer, like 200 or 404, kept for failed rows too.
      </p>
      {code && (
        <input type="text" className="input w-full mt-2 ml-6 max-w-[calc(100%-1.5rem)]"
          data-testid="http-status-code-name" value={code.columnName} placeholder="Response code"
          onChange={(e) => rename(e.target.value)} />
      )}
    </div>
  )
}

export const ResponsePane: React.FC<Props> = ({
  config, masterColumnName, errors, updateConfig,
  addResponseMapping, removeResponseMapping, updateResponseMapping,
}) => (
  <div className="space-y-4">
    <div className="bg-white border border-cube-black p-3">
      <h4 className="text-sm font-medium text-cube-black mb-2">Extract fields from JSON response</h4>
      <p className="text-xs text-cube-black">
        Use JSONPath expressions to extract specific fields from the API response into new columns.
      </p>
      <p className="text-xs text-gray-600 mt-1">
        To pick an item by a condition (the work email in a list of emails), extract $ (the whole response)
        into a column, then add a Formula column that reads it.
      </p>
    </div>

    <div>
      <div className="flex items-center justify-between mb-3">
        <label className="block text-sm font-medium text-gray-700">Fields to extract *</label>
        <button onClick={addResponseMapping} className="text-xs text-cube-black hover:text-gray-700 flex items-center space-x-1">
          <Plus className="h-3 w-3" /><span>Add Field</span>
        </button>
      </div>

      <div className="space-y-3">
        {config.responseMapping.map((mapping, index) => isCode(mapping) ? null : (
          <div key={index} className="border border-gray-200 p-3">
            <div className="grid grid-cols-1 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">JSONPath Expression *</label>
                <input type="text" className="input w-full font-mono text-sm" placeholder="$.data.name"
                  value={mapping.jsonPath}
                  onChange={(e) => updateResponseMapping(index, 'jsonPath', e.target.value)} />
                <p className="text-xs text-gray-500 mt-1">Examples: $.name, $.data[0].value, $.results[*].title</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">New Column Name *</label>
                <input type="text" className="input w-full" placeholder="extracted_field"
                  value={mapping.columnName}
                  onChange={(e) => updateResponseMapping(index, 'columnName', e.target.value)} />
              </div>
            </div>
            <div className="flex justify-end mt-2">
              <button onClick={() => removeResponseMapping(index)} className="text-xs text-cube-black hover:text-red-700 flex items-center space-x-1">
                <Minus className="h-3 w-3" /><span>Remove</span>
              </button>
            </div>
          </div>
        ))}
      </div>

      {errors.responseMapping && <p className="text-xs text-cube-black mt-2">{errors.responseMapping}</p>}
      {errors.duplicateColumns && <p className="text-xs text-cube-black mt-2">{errors.duplicateColumns}</p>}
    </div>

    <ResponseCodeField config={config} masterColumnName={masterColumnName} updateConfig={updateConfig} />
  </div>
)
