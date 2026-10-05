import React from 'react'
import { Key } from 'lucide-react'
import { APIKeySuggestion } from '@/utils/api'

type Suggestion =
  | ({ type: 'column'; name: string; reference: string })
  | (APIKeySuggestion & { type: 'api_key' })

interface Props {
  show: boolean
  suggestions: Suggestion[]
  filter: string
  activeIndex: number
  onSelect: (reference: string) => void
  onDismiss: () => void
}

export const SuggestionsDropdown: React.FC<Props> = ({
  show, suggestions, filter, activeIndex, onSelect, onDismiss,
}) => {
  if (!show || suggestions.length === 0) return null
  return (
    <>
      <div className="fixed inset-0 z-[60]" onClick={onDismiss} />
      <div className="fixed z-[70] bg-white border border-gray-200 shadow-lg max-w-sm"
        style={{ left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }}>
        <div className="p-2 border-b border-gray-100 flex items-center justify-between">
          <p className="text-xs text-gray-600">Type / to insert column or API key • Enter to add</p>
          <span className="text-[10px] text-gray-400">{filter ? `filter: ${filter}` : ''}</span>
        </div>
        <div className="max-h-40 overflow-auto">
          {suggestions.map((item, idx) => (
            <button
              key={item.type === 'api_key' ? `key-${item.name}` : `col-${item.name}`}
              onClick={() => onSelect(item.reference)}
              className={`w-full text-left px-3 py-2 text-sm ${idx === activeIndex ? 'bg-cube-black text-white' : 'hover:bg-gray-100'}`}
            >
              {item.type === 'api_key' ? (
                <>
                  <Key className={`h-3 w-3 mr-2 ${idx === activeIndex ? 'text-gray-300' : 'text-gray-400'}`} />
                  <span className={`font-mono ${idx === activeIndex ? 'text-white' : 'text-cube-black'}`}>{item.reference}</span>
                  <span className={`ml-2 ${idx === activeIndex ? 'text-gray-300' : 'text-gray-500'}`}>({item.name})</span>
                  <span className={`text-xs px-1.5 py-0.5 ml-2 ${
                    item.key_type === 'bearer' ? 'bg-green-100 text-green-700' :
                    item.key_type === 'api_key' ? 'bg-gray-100 text-gray-700' :
                    'bg-purple-100 text-purple-700'
                  }`}>{item.key_type}</span>
                </>
              ) : (
                <>
                  <span className={`font-mono ${idx === activeIndex ? 'text-white' : 'text-cube-black'}`}>{item.reference}</span>
                  <span className={`ml-2 ${idx === activeIndex ? 'text-gray-300' : 'text-gray-500'}`}>({item.name})</span>
                </>
              )}
            </button>
          ))}
        </div>
      </div>
    </>
  )
}
