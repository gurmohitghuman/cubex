import React from 'react'
import { ChevronDown, Loader2, Plus, Sparkles, Table2, Upload } from 'lucide-react'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

interface Props {
  onEmpty: () => void
  onImport: () => void
  onSample: () => void
  // A start is under way (a file importing, the sample being made): what it is doing, and nothing else starts.
  working: string | null
}

// The home's New table button: its main part opens the New Table dialog (a name, or the sample and the
// ready-made tables), its arrow the three ways to start: an empty table, a CSV file, the sample.
export const NewTableButton: React.FC<Props> = ({ onEmpty, onImport, onSample, working }) => (
  <div className="flex flex-shrink-0">
    <button type="button" onClick={onEmpty} disabled={!!working} data-testid="new-table"
      className="btn-primary flex items-center gap-2 rounded-r-none px-3 py-2 text-sm disabled:opacity-60">
      {working ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
      <span className="whitespace-nowrap">{working ?? 'New table'}</span>
    </button>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" disabled={!!working} aria-label="More ways to start a table" data-testid="new-table-menu"
          className="btn-primary rounded-l-none border-l border-white/25 px-2 py-2 disabled:opacity-60">
          <ChevronDown className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4} className="w-48">
        <DropdownMenuItem onClick={onEmpty} data-testid="new-table-empty">
          <Table2 className="mr-2 h-4 w-4" /> Empty table
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onImport} data-testid="new-table-import">
          <Upload className="mr-2 h-4 w-4" /> Import CSV
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onSample} data-testid="new-table-sample">
          <Sparkles className="mr-2 h-4 w-4" /> Try the sample
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
)
