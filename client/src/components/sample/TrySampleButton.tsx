import React from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { useSampleTable } from './useSampleTable'

// "Try with sample data": a table of 25 made-up leads, opened at once.
export const TrySampleButton: React.FC<{ className?: string }> = ({ className = '' }) => {
  const { createSample, creatingSample } = useSampleTable()
  return (
    <button type="button" onClick={() => void createSample()} disabled={creatingSample} data-testid="try-sample"
      className={'btn-secondary flex items-center justify-center space-x-2 text-sm px-4 py-2 disabled:opacity-50 '
        + className}>
      {creatingSample ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
      <span>{creatingSample ? 'Making the sample…' : 'Try with sample data'}</span>
    </button>
  )
}
