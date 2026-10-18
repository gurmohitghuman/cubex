import React, { useEffect, useState } from 'react'
import type { Column } from 'ag-grid-community'
import { RotateCcw } from 'lucide-react'
import { failedBadge } from '@/lib/run-controls-copy'
import { plural } from '@/lib/utils'

// The badge never reaches the header's middle, where a click opens the column
// menu: the words from this width, "N failed" and a retry icon from the next,
// below it only the count and the icon (the tooltip says it all).
const FULL_BADGE_MIN_PX = 280
const SHORT_BADGE_MIN_PX = 200

// The column's width now (it follows a resize).
function useColumnWidth(column: Column): number {
  const [width, setWidth] = useState(() => column.getActualWidth())
  useEffect(() => {
    const changed = () => setWidth(column.getActualWidth())
    column.addEventListener('widthChanged', changed)
    return () => column.removeEventListener('widthChanged', changed)
  }, [column])
  return width
}

interface Props { column: Column; failed: number; displayName: string; onRetry: () => void }

// A run column header's "N failed, retry": one click runs the failed rows again
// (never opens the column menu).
export const FailedBadge: React.FC<Props> = ({ column, failed, displayName, onRetry }) => {
  const width = useColumnWidth(column)
  const icon = <RotateCcw size={10} aria-hidden="true" />
  return (
    <button type="button" data-testid="retry-failed" aria-label={failedBadge(failed)}
      className={'flex flex-shrink-0 items-center gap-1 rounded-full border border-red-200 bg-red-50 px-1.5'
        + ' text-[11px] leading-4 font-medium text-red-700 hover:bg-red-100 whitespace-nowrap'}
      title={`${failedBadge(failed)}: run the ${plural(failed, 'failed row')} of "${displayName}" again`}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRetry() }}>
      {width >= FULL_BADGE_MIN_PX ? failedBadge(failed)
        : width >= SHORT_BADGE_MIN_PX ? <>{failed.toLocaleString()} failed{icon}</>
          : <>{failed.toLocaleString()}{icon}</>}
    </button>
  )
}
