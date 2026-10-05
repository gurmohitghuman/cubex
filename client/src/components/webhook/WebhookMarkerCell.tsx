import React from 'react'

// Read-only cell renderer for the webhook marker column. Display-only: a row
// that came from the webhook shows its stored "📥 HH:MM" marker; a pre-existing
// (non-webhook) row shows a muted dash so the column doesn't look broken/blank.
// The dash is NEVER written to rows.data; it's purely visual, so it can't bloat
// the row JSON or leak into CSV export.
export const WebhookMarkerCell: React.FC<{ value?: string }> = ({ value }) => {
  const v = value || ''
  if (v) return <span className="text-sm">{v}</span>
  return <span className="text-sm text-gray-300" title="Not from the webhook">-</span>
}
