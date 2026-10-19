import React from 'react'
import { Bot, Brush, ChevronDown, DatabaseZap, FunctionSquare, Globe, Layers, Link2 } from 'lucide-react'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { MenuEntry, MenuHeading, useMenuFocus } from './toolbar/MenuEntry'

interface Props {
  hasRows: boolean
  hasColumns: boolean
  onAddAIColumn: () => void
  onAddEnrichment: () => void
  onAddHTTPColumn: () => void
  onAddWaterfall: () => void
  onAddClean: () => void
  onAddFormula: () => void
  onAddLookup: () => void
}

// The sheet header's ONE primary action: AI Column, with the arrow beside it
// listing every kind of filled column, the ones that run with the person's keys
// (AI, enrichment, waterfall, HTTP API) apart from the built-in ones (clean,
// formula, lookup). Replaced four look-alike buttons that fought for the eye.
export const SheetEnrichActions: React.FC<Props> = ({
  hasRows, hasColumns, onAddAIColumn, onAddEnrichment, onAddHTTPColumn, onAddWaterfall,
  onAddClean, onAddFormula, onAddLookup,
}) => {
  const focus = useMenuFocus()
  return (
    <div className="flex shrink-0">
      <button onClick={onAddAIColumn} disabled={!hasRows} aria-label="AI Column"
        className="btn-primary flex h-8 items-center gap-1.5 rounded-r-none"
        title="AI Column: a prompt per row, run with your own OpenRouter key">
        <Bot className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="hidden sm:inline">AI Column</span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button ref={focus.trigger} data-testid="column-types-menu"
            className="btn-primary h-8 rounded-l-none border-l border-gray-600 px-2"
            aria-label="More column types" title="Every kind of column that fills itself">
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[21rem]" onCloseAutoFocus={focus.onCloseAutoFocus}>
          <MenuHeading>Runs with your keys</MenuHeading>
          <MenuEntry icon={Bot} label="AI Column" hint="A prompt per row, with your OpenRouter key"
            onSelect={focus.opening(onAddAIColumn)} disabled={!hasRows} testId="add-ai-column" />
          <MenuEntry icon={DatabaseZap} label="Enrichment" hint="Emails, phones, company and person data"
            onSelect={focus.opening(onAddEnrichment)} disabled={!hasRows} testId="add-enrichment" />
          <MenuEntry icon={Layers} label="Waterfall" hint="Try sources in order until one finds the value"
            onSelect={focus.opening(onAddWaterfall)} disabled={!hasRows} testId="add-waterfall" />
          <MenuEntry icon={Globe} label="HTTP API" hint="Call any API per row, keep the fields you pick"
            onSelect={focus.opening(onAddHTTPColumn)} disabled={!hasRows} testId="add-http-api" />
          <DropdownMenuSeparator />
          <MenuHeading>Built in</MenuHeading>
          <MenuEntry icon={Brush} label="Clean data" hint="Tidy names, emails, domains and phones"
            onSelect={focus.opening(onAddClean)} disabled={!hasColumns} testId="add-clean" />
          <MenuEntry icon={FunctionSquare} label="Formula" hint="Work a value out of each row"
            onSelect={focus.opening(onAddFormula)} disabled={!hasColumns} testId="add-formula" />
          <MenuEntry icon={Link2} label="Lookup" hint="Bring values in from another sheet"
            onSelect={focus.opening(onAddLookup)} disabled={!hasColumns} testId="add-lookup" />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
