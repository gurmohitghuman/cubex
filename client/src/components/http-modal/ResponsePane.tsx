import React from 'react'
import { Filter, Minus, Plus } from 'lucide-react'
import { HTTPAPIConfig } from './types'

interface Props {
  config: HTTPAPIConfig
  errors: Record<string, string>
  updateConfig: (updates: Partial<HTTPAPIConfig>) => void
  addResponseMapping: () => void
  removeResponseMapping: (i: number) => void
  updateResponseMapping: (i: number, field: 'jsonPath' | 'columnName', value: string) => void
}

export const ResponsePane: React.FC<Props> = ({
  config, errors, updateConfig, addResponseMapping, removeResponseMapping, updateResponseMapping,
}) => (
  <div className="space-y-4">
    <div className="bg-white border border-cube-black p-3">
      <h4 className="text-sm font-medium text-cube-black mb-2">Extract fields from JSON response</h4>
      <p className="text-xs text-cube-black">
        Use JSONPath expressions to extract specific fields from the API response into new columns.
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
        {config.responseMapping.map((mapping, index) => (
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

    <div>
      <label className="flex items-center space-x-2">
        <input type="checkbox" checked={config.skipMissingFields}
          onChange={(e) => updateConfig({ skipMissingFields: e.target.checked })}
          className=" border-gray-300 text-cube-black focus:ring-cube-black/20" />
        <span className="text-sm text-gray-700">Skip rows where mapped fields are missing</span>
        <Filter className="h-4 w-4 text-gray-400" />
      </label>
      <p className="text-xs text-gray-500 mt-1 ml-6">
        When enabled, rows that don&apos;t have values for the specified JSONPath will be skipped
      </p>
    </div>
  </div>
)
