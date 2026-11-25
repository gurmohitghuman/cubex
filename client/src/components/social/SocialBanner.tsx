import React, { useCallback, useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Megaphone } from 'lucide-react'
import type { SheetData } from '@/utils/api/types'
import type { SocialView } from '@/utils/api/social'
import { FindPostsDialog } from './FindPostsDialog'

// Above the grid of a social research table's sheets: the topic, its sheets, Find posts (the cost first), and what
// to do next. A new table opens on what finding its posts costs.
const LABELS: Record<string, string> = { tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube', x: 'X' }

export const SocialBanner: React.FC<{ v: SocialView; sheetId: string; onChanged: () => void }> =
  ({ v, sheetId, onChanged }) => {
    const navigate = useNavigate()
    const location = useLocation()
    const [finding, setFinding] = useState(false)
    useEffect(() => {
      if ((location.state as { socialFind?: string } | null)?.socialFind !== v.id) return
      navigate(location.pathname, { replace: true, state: null })
      setFinding(true)
    }, [location.state, location.pathname, navigate, v.id])
    const close = useCallback(() => setFinding(false), [])

    const sheets: Array<[string, string]> = [
      ['Searches', v.searches_sheet_id],
      ...Object.entries(v.posts_sheets).map(([p, id]) => [`${LABELS[p] ?? p} posts`, id!] as [string, string]),
      ...(v.comments_sheet_id ? [['Comments', v.comments_sheet_id] as [string, string]] : []),
    ]
    const f = v.filters
    const filters = [f.min_views !== null ? `at least ${f.min_views.toLocaleString('en-US')} views` : '',
      f.posted_within_days !== null ? `posted in the last ${f.posted_within_days} days` : ''].filter(Boolean)
    return (
      <div className="mx-4 mt-3 mb-1 border border-gray-200 bg-white rounded-lg px-4 py-3" data-testid="social-banner">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Megaphone className="h-4 w-4 text-gray-900" />
          <span className="text-sm font-semibold text-gray-900">Social research: {v.topic}</span>
          {filters.length > 0 && <span className="text-xs text-gray-500">Top posts: {filters.join(', ')}</span>}
          <span className="flex flex-wrap items-center gap-1 text-xs">
            {sheets.map(([name, id]) => (
              <button key={id} type="button" disabled={id === sheetId} className={`px-2 py-0.5 rounded ${
                id === sheetId ? 'bg-gray-100 text-gray-900' : 'text-gray-600 underline'}`}
                onClick={() => navigate(`/table/${v.table_id}/${id}`)}>{name}</button>
            ))}
          </span>
          <span className="flex-1" />
          <button type="button" className="btn-secondary text-xs px-3 py-1" onClick={() => setFinding(true)}
            data-testid="social-find">Find posts…</button>
        </div>
        <p className="text-xs text-gray-600 mt-2" data-testid="social-next">
          {v.steps.length > 0
            ? 'Next: on a posts sheet, open a step\'s column menu (Transcript, Breakdown, Creator, Comments found) '
              + 'and run it. It shows the cost first.'
            : 'Find posts adds the posts to each platform\'s sheet. Run it again later to find what\'s new.'}
        </p>
        {finding && <FindPostsDialog v={v} onClose={close} onStarted={onChanged} />}
      </div>
    )
  }

// The guide when the open sheet is one of a social research table's.
export const SheetSocialBanner: React.FC<{ sheetData: SheetData | null; onChanged: () => void }> =
  ({ sheetData, onChanged }) => {
    const v = sheetData?.data.social
    const sheetId = sheetData?.sheet?.id
    if (!v || !sheetId) return null
    return <SocialBanner key={v.id} v={v} sheetId={sheetId} onChanged={onChanged} />
  }
