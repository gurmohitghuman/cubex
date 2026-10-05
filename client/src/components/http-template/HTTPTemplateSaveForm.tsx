import React, { useState } from 'react'

interface SaveFormProps {
  onSave: (name: string, description?: string, tags?: string, isDraft?: boolean) => Promise<void>
  onCancel: () => void
}

export const HTTPTemplateSaveForm: React.FC<SaveFormProps> = ({ onSave, onCancel }) => {
  const [form, setForm] = useState({ name: '', description: '', tags: '', isDraft: false })

  const handleSave = async () => {
    if (!form.name.trim()) return
    await onSave(form.name.trim(), form.description.trim() || undefined, form.tags.trim() || undefined, form.isDraft)
    setForm({ name: '', description: '', tags: '', isDraft: false })
  }

  return (
    <div>
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Template Name *</label>
          <input
            type="text"
            value={form.name}
            onChange={(e) => setForm(prev => ({ ...prev, name: e.target.value }))}
            placeholder="e.g., Debounce API, Company Enrichment…"
            className="input w-full"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
          <textarea
            value={form.description}
            onChange={(e) => setForm(prev => ({ ...prev, description: e.target.value }))}
            placeholder="Brief description of what this template does…"
            rows={3}
            className="input w-full h-28"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Tags</label>
          <input
            type="text"
            value={form.tags}
            onChange={(e) => setForm(prev => ({ ...prev, tags: e.target.value }))}
            placeholder="email, validation, enrichment (comma-separated)"
            className="input w-full"
          />
          <p className="text-xs text-gray-500 mt-1">Separate multiple tags with commas</p>
        </div>
        <div className="flex items-center">
          <input
            type="checkbox"
            id="isDraft"
            checked={form.isDraft}
            onChange={(e) => setForm(prev => ({ ...prev, isDraft: e.target.checked }))}
            className="mr-2 border-gray-300 text-cube-black focus:ring-black"
          />
          <label htmlFor="isDraft" className="text-sm text-gray-700">
            Save as draft (won&apos;t appear in main template list)
          </label>
        </div>
      </div>
      <div className="flex gap-3 mt-6 pt-4 border-t">
        <button onClick={handleSave} className="btn-primary">Save Template</button>
        <button onClick={onCancel} className="btn-secondary">Cancel</button>
      </div>
    </div>
  )
}
