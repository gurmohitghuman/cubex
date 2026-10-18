import React from 'react'
import { Bot, DatabaseZap, Globe, Inbox, Layers } from 'lucide-react'

interface Props {
  hasRows: boolean
  onAddAIColumn: () => void
  onAddEnrichment: () => void
  onAddHTTPColumn: () => void
  onAddWaterfall: () => void
  onOpenWebhook: () => void
}

// The sheet header's enrich group, split out of SheetHeader (200-line
// guardrail). AI Column is the SINGLE filled/primary action; Enrichment, HTTP
// API and Webhook are secondary so the hierarchy has one clear hero (was three
// near-identical black buttons).
export const SheetEnrichActions: React.FC<Props> = ({
  hasRows, onAddAIColumn, onAddEnrichment, onAddHTTPColumn, onAddWaterfall, onOpenWebhook,
}) => (
  <div className="flex items-center space-x-1">
    <button
      onClick={onAddAIColumn}
      className="btn-primary flex items-center space-x-1"
      disabled={!hasRows}
      title="AI Column: Preview, configure, and run AI processing with full control"
    >
      <Bot className="h-3 w-3" />
      <span>AI Column</span>
    </button>

    <button
      onClick={onAddEnrichment}
      className="btn-secondary flex items-center space-x-1"
      disabled={!hasRows}
      title="Enrichment: find emails, phones, company and person data with your treg key"
    >
      <DatabaseZap className="h-3 w-3" />
      <span>Enrichment</span>
    </button>

    <button
      onClick={onAddWaterfall}
      className="btn-secondary flex items-center space-x-1"
      disabled={!hasRows}
      title="Waterfall: find one value per row by trying tools, AI and APIs in turn until one answers"
      aria-label="Waterfall"
    >
      <Layers className="h-3 w-3" />
      {/* Icon only on narrower screens, as Setups, so the toolbar stays on one line. */}
      <span className="hidden min-[1440px]:inline">Waterfall</span>
    </button>

    <button
      onClick={onAddHTTPColumn}
      className="btn-secondary flex items-center space-x-1"
      disabled={!hasRows}
      title="HTTP API: Call any REST API per row and map response fields into new columns"
    >
      <Globe className="h-3 w-3" />
      <span>HTTP API</span>
    </button>

    <button
      onClick={onOpenWebhook}
      className="btn-secondary flex items-center space-x-1"
      title="Webhook: receive external events as new rows in this sheet"
    >
      <Inbox className="h-3 w-3" />
      <span>Webhook</span>
    </button>
  </div>
)
