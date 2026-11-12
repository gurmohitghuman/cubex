import React from 'react'
import type { FetchLimitSettings } from '@/utils/api'
import { Select } from '../ui/Select'
import {
  WEB_FETCH_MAX_CONTENT_TOKENS_MIN, WEB_FETCH_MAX_CONTENT_TOKENS_MAX, WEB_FETCH_MAX_PAGES_PER_ROW,
} from '@/lib/constants'

// Under "Fetch URLs": how much of each page a row reads, and how many pages. A
// page's text goes into the prompt, so these bound what a row costs. With
// either set the server reads pages through Exa, which applies both (a model's
// own fetch doesn't cut pages).

const PAGES = [1, 2, 3, 5, 10, 20, WEB_FETCH_MAX_PAGES_PER_ROW]

interface Props {
  value: FetchLimitSettings
  onChange: (v: FetchLimitSettings) => void
}

export const WebFetchLimits: React.FC<Props> = ({ value, onChange }) => {
  const tokens = value.maxContentTokens
  const outOfRange = tokens !== null
    && (tokens < WEB_FETCH_MAX_CONTENT_TOKENS_MIN || tokens > WEB_FETCH_MAX_CONTENT_TOKENS_MAX)
  const pages = value.maxPagesPerRow
  return (
    <div className="mt-2 ml-6 space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <label className="block min-w-0">
          <span className="block text-xs text-gray-600 mb-1">Tokens per page</span>
          <input type="number" inputMode="numeric" min={WEB_FETCH_MAX_CONTENT_TOKENS_MIN}
            max={WEB_FETCH_MAX_CONTENT_TOKENS_MAX} step={100} placeholder="No limit" aria-label="Tokens per page"
            value={tokens ?? ''} data-testid="fetch-max-content-tokens"
            onChange={e => onChange({
              ...value, maxContentTokens: e.target.value === '' ? null : Math.floor(Number(e.target.value)),
            })}
            className="w-full rounded border border-gray-300 px-2 py-1 text-sm" />
        </label>
        <label className="block min-w-0">
          <span className="block text-xs text-gray-600 mb-1">Pages per row</span>
          <Select<string | number> className="w-full" value={pages ?? ''} label="Pages per row"
            onChange={v => onChange({ ...value, maxPagesPerRow: v ? Number(v) : null })}
            options={[{ value: '', label: 'No limit' },
              ...[...new Set([...PAGES, ...(pages !== null ? [pages] : [])])].sort((a, b) => a - b)
                .map(n => ({ value: n, label: `Up to ${n}` }))]} />
        </label>
      </div>
      {outOfRange ? (
        <p className="text-xs text-red-600" role="alert">
          Tokens per page must be from {WEB_FETCH_MAX_CONTENT_TOKENS_MIN} to{' '}
          {WEB_FETCH_MAX_CONTENT_TOKENS_MAX.toLocaleString('en-US')}.
        </p>
      ) : (tokens !== null || pages !== null) && (
        <p className="text-xs text-gray-500">With a limit, pages are read through Exa, at about $0.001 a page.</p>
      )}
    </div>
  )
}
