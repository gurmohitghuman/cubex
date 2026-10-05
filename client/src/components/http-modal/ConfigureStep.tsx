import React from 'react'
import { Bookmark, Eye, Loader2 } from 'lucide-react'
import { HTTPAPIConfig } from './types'
import { AccordionSection } from '../AccordionSection'
import {
  MasterColumnField, MethodEndpointFields, QueryParamsFields, HeadersFields, BodyField,
} from './RequestSections'
import { ResponsePane } from './ResponsePane'
import { SettingsPane } from './SettingsPane'

interface Props {
  config: HTTPAPIConfig
  errors: Record<string, string>
  masterColumnName: string
  setMasterColumnName: (v: string) => void
  updateConfig: (updates: Partial<HTTPAPIConfig>) => void
  addQueryParam: () => void
  removeQueryParam: (i: number) => void
  updateQueryParam: (i: number, field: 'key' | 'value', value: string) => void
  addHeader: () => void
  removeHeader: (i: number) => void
  updateHeader: (i: number, field: 'key' | 'value', value: string) => void
  addResponseMapping: () => void
  removeResponseMapping: (i: number) => void
  updateResponseMapping: (i: number, field: 'jsonPath' | 'columnName', value: string) => void
  handleInputChange: (value: string, targetId: string, updateFn: () => void) => void
  handleSuggestionKeyDown: (e: React.KeyboardEvent, targetId: string) => void
  isGeneratingPreview: boolean
  previewError: string | null
  onPreview: () => void | Promise<void>
  onCancel: () => void
  onShowTemplateModal: () => void
}

// Clay-style vertical accordion (replaces the old 3-tab horizontal layout). Each
// request/response/settings group is an independently-collapsible AccordionSection
// so the narrow drawer reads as a workspace. Method & Endpoint is open by default;
// the Body section only appears for methods that carry a body (was the same
// POST/PUT/DELETE conditional). Collapsed summaries show counts / a truncated URL.
export const ConfigureStep: React.FC<Props> = (p) => {
  const hasBody = ['POST', 'PUT', 'DELETE'].includes(p.config.method)
  const endpointSummary = `${p.config.method}${p.config.endpointUrl ? ` · ${p.config.endpointUrl}` : ''}`
  return (
    <div className="p-4 space-y-3">
      <MasterColumnField masterColumnName={p.masterColumnName} setMasterColumnName={p.setMasterColumnName} errors={p.errors} />

      <AccordionSection title="Method & Endpoint" summary={endpointSummary} defaultOpen>
        <MethodEndpointFields {...p} />
      </AccordionSection>

      <AccordionSection title="Query Parameters" summary={p.config.queryParams.length ? `${p.config.queryParams.length}` : undefined}>
        <QueryParamsFields {...p} />
      </AccordionSection>

      {hasBody && (
        <AccordionSection title="Request Body (JSON)">
          <BodyField {...p} />
        </AccordionSection>
      )}

      <AccordionSection title="Headers" summary={p.config.headers.length ? `${p.config.headers.length}` : undefined}>
        <HeadersFields {...p} />
      </AccordionSection>

      <AccordionSection title="Response Values" summary={p.config.responseMapping.length ? `${p.config.responseMapping.length} mapped` : undefined}>
        <ResponsePane config={p.config} errors={p.errors} updateConfig={p.updateConfig}
          addResponseMapping={p.addResponseMapping} removeResponseMapping={p.removeResponseMapping}
          updateResponseMapping={p.updateResponseMapping} />
      </AccordionSection>

      <AccordionSection title="Run Settings">
        <SettingsPane config={p.config} updateConfig={p.updateConfig} />
      </AccordionSection>

      <div className="flex justify-between pt-4 border-t border-gray-200">
        <button onClick={p.onShowTemplateModal}
          className="flex items-center gap-2 px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 transition-colors">
          <Bookmark className="h-4 w-4" />Save as Template
        </button>
        <div className="flex space-x-3">
          <button onClick={p.onCancel} className="btn-secondary">Cancel</button>
          <button onClick={p.onPreview} disabled={p.isGeneratingPreview}
            className="btn-primary flex items-center space-x-2">
            {p.isGeneratingPreview ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
            <span>{p.isGeneratingPreview ? `Processing ${p.config.previewSize} rows…` : `Try on ${p.config.previewSize} rows`}</span>
          </button>
        </div>
      </div>

      {p.previewError && <div className="mt-3 p-3 bg-cube-black text-sm text-white">{p.previewError}</div>}
    </div>
  )
}
