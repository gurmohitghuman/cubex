import React, { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { httpAPI } from '@/utils/api'
import toast from 'react-hot-toast'
import Modal from './Modal'
import { HTTPTemplateBrowser, type HTTPTemplate } from './http-template/HTTPTemplateBrowser'
import { HTTPTemplateSaveForm } from './http-template/HTTPTemplateSaveForm'

interface HTTPTemplateModalProps {
  isOpen: boolean
  onClose: () => void
  onSelectTemplate: (template: HTTPTemplate) => void
  currentConfig?: any
  onSaveAsTemplate?: (name: string, description?: string, tags?: string, isDraft?: boolean) => void
}

export default function HTTPTemplateModal({
  isOpen, onClose, onSelectTemplate, currentConfig, onSaveAsTemplate,
}: HTTPTemplateModalProps) {
  const [templates, setTemplates] = useState<HTTPTemplate[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<'browse' | 'save'>('browse')

  const loadTemplates = async (search?: string) => {
    try {
      setLoading(true)
      setTemplates(await httpAPI.getTemplates(search))
    } catch (error) {
      console.error('Error loading templates:', error)
      toast.error('Failed to load templates')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { if (isOpen) loadTemplates() }, [isOpen])

  // Debounce searches so typing doesn't fire a request per keystroke.
  useEffect(() => {
    if (!searchQuery) { loadTemplates(); return }
    const t = setTimeout(() => loadTemplates(searchQuery), 300)
    return () => clearTimeout(t)
  }, [searchQuery])

  const handleSelectTemplate = async (template: HTTPTemplate) => {
    try {
      await httpAPI.useTemplate(template.id)
      onSelectTemplate(template)
      onClose()
      toast.success(`Applied template: ${template.name}`)
    } catch (error) {
      console.error('Error using template:', error)
      toast.error('Failed to apply template')
    }
  }

  const handleDeleteTemplate = async (template: HTTPTemplate, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirm(`Are you sure you want to delete "${template.name}"?`)) return
    try {
      await httpAPI.deleteTemplate(template.id)
      await loadTemplates(searchQuery)
      // No success toast — the template row disappears from the list immediately.
    } catch (error) {
      console.error('Error deleting template:', error)
      toast.error('Failed to delete template')
    }
  }

  const handleSaveTemplate = async (name: string, description?: string, tags?: string, isDraft?: boolean) => {
    if (!currentConfig) { toast.error('No configuration to save'); return }
    try {
      await httpAPI.createTemplate({ name, description, config: currentConfig, tags, is_draft: isDraft })
      toast.success('Template saved successfully')
      setActiveTab('browse')
      await loadTemplates()
    } catch (error) {
      console.error('Error saving template:', error)
      toast.error('Failed to save template')
    }
  }

  // zClassName z-[20010] stacks this above the HTTP API drawer (z-[20000]) it opens
  // from, so the template browser layers on top and Escape closes it first.
  return (
    <Modal isOpen={isOpen} onClose={onClose} panelClassName="max-w-4xl w-full max-h-[85vh]" zClassName="z-[20010]">
      <div className="flex items-center justify-between p-6 border-b">
        <h2 className="text-title text-gray-900">HTTP API Templates</h2>
        <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded-sm">
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="p-6">
        <div className="flex mb-6 border-b">
          <button
            onClick={() => setActiveTab('browse')}
            className={`px-4 py-2 border-b-2 transition-colors ${
              activeTab === 'browse' ? 'border-cube-black text-cube-black'
                : 'border-transparent text-gray-500 hover:text-cube-black'
            }`}
          >Browse Templates</button>
          {onSaveAsTemplate && (
            <button
              onClick={() => setActiveTab('save')}
              className={`px-4 py-2 border-b-2 transition-colors ${
                activeTab === 'save' ? 'border-cube-black text-cube-black'
                  : 'border-transparent text-gray-500 hover:text-cube-black'
              }`}
            >Save Current Config</button>
          )}
        </div>

        {activeTab === 'browse' ? (
          <HTTPTemplateBrowser
            templates={templates}
            loading={loading}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            onSelect={handleSelectTemplate}
            onDelete={handleDeleteTemplate}
          />
        ) : (
          <HTTPTemplateSaveForm onSave={handleSaveTemplate} onCancel={() => setActiveTab('browse')} />
        )}
      </div>
    </Modal>
  )
}
