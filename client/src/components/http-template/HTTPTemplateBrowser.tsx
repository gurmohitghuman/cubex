import React from 'react'
import { Bookmark, Clock, Search, Tag, Trash2 } from 'lucide-react'

export interface HTTPTemplate {
  id: string
  name: string
  description?: string
  config: any
  tags?: string
  is_draft: boolean
  usage_count: number
  created_at: string
  updated_at: string
}

interface BrowserProps {
  templates: HTTPTemplate[]
  loading: boolean
  searchQuery: string
  setSearchQuery: (q: string) => void
  onSelect: (t: HTTPTemplate) => void
  onDelete: (t: HTTPTemplate, e: React.MouseEvent) => void
}

const formatDate = (s: string) => new Date(s).toLocaleDateString()
const tagsArray = (tags?: string) => !tags ? [] : tags.split(',').map(t => t.trim()).filter(Boolean)

export const HTTPTemplateBrowser: React.FC<BrowserProps> = ({
  templates, loading, searchQuery, setSearchQuery, onSelect, onDelete,
}) => (
  <div>
    <div className="mb-6">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
        <input
          type="text"
          placeholder="Search templates by name, description, or tags…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="input w-full pl-10 pr-4 py-2"
        />
      </div>
    </div>

    <div className="space-y-4 max-h-96 overflow-y-auto">
      {loading ? (
        <div className="text-center py-8 text-gray-500">Loading templates…</div>
      ) : templates.length === 0 ? (
        <div className="text-center py-8 text-gray-500">
          {searchQuery ? 'No templates found matching your search.' : 'No templates available.'}
        </div>
      ) : (
        templates.map((template) => (
          <div
            key={template.id}
            onClick={() => onSelect(template)}
            className="border border-gray-200 rounded-sm p-4 hover:bg-gray-50 cursor-pointer transition-colors"
          >
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-2">
                  <h3 className="font-medium text-lg">{template.name}</h3>
                  {template.is_draft && (
                    <span className="px-2 py-1 bg-white text-cube-black border border-cube-black text-xs rounded-sm">Draft</span>
                  )}
                </div>
                {template.description && (
                  <p className="text-gray-600 mb-2">{template.description}</p>
                )}
                <div className="flex items-center gap-4 text-sm text-gray-500">
                  <span className="flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {formatDate(template.created_at)}
                  </span>
                  <span className="flex items-center gap-1">
                    <Bookmark className="w-3 h-3" />
                    Used {template.usage_count} times
                  </span>
                </div>
                {template.tags && (
                  <div className="flex gap-2 mt-2">
                    {tagsArray(template.tags).map((tag, index) => (
                      <span key={index} className="px-2 py-1 bg-gray-100 text-cube-black text-xs rounded-sm flex items-center gap-1">
                        <Tag className="w-3 h-3" />
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex gap-1 ml-4">
                <button
                  onClick={(e) => onDelete(template, e)}
                  className="p-1 text-gray-600 hover:bg-gray-100 rounded-sm transition-colors"
                  title="Delete template"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  </div>
)
