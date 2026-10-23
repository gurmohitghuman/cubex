import React from 'react'
import { useNavigate } from 'react-router-dom'
import type { AiVisibilityCheck } from '@/utils/api/ai-visibility'

// The guide's line about the latest "Check again": still going, done (where
// the kept answers are, the column saying what moved), or stopped (what
// stopped it; Check again picks it up while its kept answers are there).
export const LastCheck: React.FC<{ check: AiVisibilityCheck; tableId: string }> = ({ check: c, tableId }) => {
  const navigate = useNavigate()
  const going = c.stage === 'copying' || c.stage === 'comparing' || c.stage === 'asking'
  const words = going ? `Checking again: keeping the answers of ${c.label}…`
    : c.stage === 'done' ? <>Last check: the answers of {c.label} are kept; <b>{c.changeColumn}</b> says what moved.</>
      : `The last check stopped${c.problems[0] ? `: ${c.problems[0]}` : '.'}`
  return (
    <div className={`text-xs mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 ${
      c.stage === 'stopped' ? 'text-red-600' : 'text-gray-600'}`} data-testid="ai-visibility-last-check">
      <span>{words}</span>
      {c.questionsCopySheetId && (
        <button type="button" className="underline text-gray-600"
          onClick={() => navigate(`/table/${tableId}/${c.questionsCopySheetId}`)}>Open the answers of {c.label}</button>
      )}
    </div>
  )
}
