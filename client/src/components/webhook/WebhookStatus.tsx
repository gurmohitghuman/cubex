import React from 'react'

// Status section of the webhook drawer: active/disabled dot, enable/disable +
// delete actions, the running event count, and the last-error line. Extracted
// from WebhookDrawer to keep that file under the 200-line cap.
export function WebhookStatus({
  source, onToggle, onDelete, busy,
}: {
  source: { enabled: boolean; totalReceived: number; lastReceivedAt: string | null; lastErrorMessage: string | null }
  onToggle: (b: boolean) => void
  onDelete: () => void
  busy: boolean
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${source.enabled ? 'bg-green-500' : 'bg-gray-300'}`} />
          <span className="text-sm font-medium text-gray-800">{source.enabled ? 'Active' : 'Disabled'}</span>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => onToggle(!source.enabled)} className="text-xs text-gray-500 hover:text-cube-black">
            {source.enabled ? 'Disable' : 'Enable'}
          </button>
          <button type="button" onClick={onDelete} disabled={busy} className="text-xs text-red-500 hover:text-red-700 disabled:opacity-50">
            Delete
          </button>
        </div>
      </div>
      <p className="text-xs text-gray-500">
        {source.totalReceived} event{source.totalReceived === 1 ? '' : 's'} received
        {source.lastReceivedAt && ` · last ${new Date(source.lastReceivedAt + 'Z').toLocaleString()}`}
      </p>
      {source.lastErrorMessage && (
        <p className="text-xs text-red-600">⚠ {source.lastErrorMessage}</p>
      )}
    </section>
  )
}
