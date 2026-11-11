import React from 'react'
import toast from 'react-hot-toast'
import { plural } from '@/lib/utils'

// The first cells of an import that looked garbled, by row id, then column.
export type GarbledSamples = Record<string, Record<string, string>>

// After a CSV import with cells that look like text read with the wrong
// character set (FraudFighterâ¢ where FraudFighter™ was meant): how many, the
// first few as "Column: value", and the cleaner that repairs them.
export function toastImportGarbled(cells: number, samples: GarbledSamples): void {
  const shown = Object.values(samples).flatMap(row => Object.entries(row))
  toast(() => (
    <div className="min-w-0 text-sm" data-testid="import-garbled-toast">
      <p className="break-words">
        {plural(cells, 'cell')} {cells === 1 ? 'looks' : 'look'} garbled, like text read with the wrong character
        set. A Clean data column with Fix garbled characters can repair them.
      </p>
      <ul className="mt-1 space-y-0.5 text-xs opacity-80">
        {shown.map(([column, value], i) => (
          <li key={`${i}-${column}`} className="break-words">
            <span className="font-medium">{column}:</span> {value}
          </li>
        ))}
      </ul>
    </div>
  ), { id: 'import-garbled', duration: 15000, icon: '⚠️' })
}
