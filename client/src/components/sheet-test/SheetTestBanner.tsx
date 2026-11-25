import React, { useState } from 'react'
import { ChevronDown, FlaskConical } from 'lucide-react'
import type { SheetData } from '@/utils/api/types'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { SHEET_TEST_MAX_ROWS } from '@/lib/constants'
import { plural } from '@/lib/utils'
import type { SheetTestControls } from '@/hooks/sheet/useSheetTest'
import { ApplyTestDialog } from './ApplyTestDialog'

// Above the grid while a sheet's column changes are being tried on sample rows (utils/api/sheet-test.ts). On the
// copy: what it is, Add rows, Discard and Apply. On the sheet itself: it can't change until the test ends, with
// the way to the test.
export const SheetTestBanner: React.FC<{
  sheetData: SheetData | null; activeSheetId: string | null; controls: SheetTestControls
}> = ({ sheetData, activeSheetId, controls }) => {
  const [applying, setApplying] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const test = sheetData?.data.test
  if (!test || !activeSheetId) return null
  const onCopy = activeSheetId === test.test_sheet_id
  const name = test.sheet_name
  const box = 'mx-4 mt-3 mb-1 border rounded-lg px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-2'
  if (test.state === 'ending') {
    return (
      <div className={`${box} border-gray-200 bg-white`} data-testid="sheet-test-banner">
        <FlaskConical className="h-4 w-4 text-gray-900" aria-hidden="true" />
        <span className="text-sm text-gray-700">The test of {name} is closing…</span>
      </div>
    )
  }
  const discard = (
    <>
      <button type="button" className="btn-secondary text-xs px-3 py-1" onClick={() => setDiscarding(true)}
        data-testid="sheet-test-discard">Discard test</button>
      <ConfirmDialog isOpen={discarding} title="Discard the test?" isDestructive confirmText="Discard test"
        cancelText="Keep testing"
        message={`The test copy and its changes are deleted, and ${name} stays as it was. What ran on the copy `
          + 'was paid for and stays in Usage.'}
        onConfirm={() => { setDiscarding(false); void controls.discard(test) }}
        onCancel={() => setDiscarding(false)} />
    </>
  )
  if (!onCopy) {
    return (
      <div className={`${box} border-amber-200 bg-amber-50`} data-testid="sheet-test-banner">
        <FlaskConical className="h-4 w-4 text-amber-800" aria-hidden="true" />
        <span className="text-sm text-amber-900">
          Changes are being tried on {plural(test.rows, 'sample row')} of this sheet. It can't be changed until the
          test is applied or discarded.
        </span>
        <span className="flex-1" />
        <button type="button" className="btn-primary text-xs px-3 py-1"
          onClick={() => { void controls.open(test.test_sheet_id) }} data-testid="sheet-test-open">
          Open the test</button>
        {discard}
      </div>
    )
  }
  const full = test.rows >= SHEET_TEST_MAX_ROWS
  return (
    <div className={`${box} border-blue-200 bg-blue-50`} data-testid="sheet-test-banner">
      <FlaskConical className="h-4 w-4 text-blue-900" aria-hidden="true" />
      <span className="text-sm text-blue-950">
        <span className="font-semibold">Test copy of {name}</span>: {plural(test.rows, 'sample row')}. Change and run
        columns here; {name} doesn't change until you apply.
      </span>
      <span className="flex-1" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="btn-secondary text-xs px-3 py-1 flex items-center gap-1 disabled:opacity-50"
            disabled={full} title={full ? `A test holds at most ${SHEET_TEST_MAX_ROWS} rows` : undefined}
            data-testid="sheet-test-add-rows">
            Add rows <ChevronDown className="h-3 w-3" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => { void controls.addRows(test, 'top') }} data-testid="sheet-test-add-top">
            10 more from the top</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => { void controls.addRows(test, 'random') }}
            data-testid="sheet-test-add-random">10 at random</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {discard}
      <button type="button" className="btn-primary text-xs px-3 py-1" onClick={() => setApplying(true)}
        data-testid="sheet-test-apply">Apply to {name}…</button>
      <ApplyTestDialog test={applying ? test : null} onClose={() => setApplying(false)}
        onApplied={answer => { setApplying(false); void controls.applied(answer) }} />
    </div>
  )
}
