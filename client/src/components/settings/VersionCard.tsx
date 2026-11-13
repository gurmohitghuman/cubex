import React, { useState } from 'react'
import { Loader2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { versionAPI, type VersionInfo } from '@/utils/api'
import { setVersionInfo, useVersionInfo } from '@/hooks/useVersionInfo'

// Settings → Account → Version: the running version and, while the daily check is on, the latest
// release on GitHub with its notes. A newer release gets a line here and a dot on Settings and on this
// tab. A check that failed shows nothing (the last answer stays); only "Check now" says so.
const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

export const VersionCard: React.FC = () => {
  const info = useVersionInfo()
  const [busy, setBusy] = useState<'check' | 'toggle' | null>(null)
  if (!info) return null

  // `before`: what to show again if the call fails (the toggle shows its new state at once).
  const act = async (what: 'check' | 'toggle', call: () => Promise<VersionInfo & { reached?: boolean }>,
    before?: VersionInfo) => {
    setBusy(what)
    try {
      const next = await call()
      setVersionInfo(next)
      if (next.reached === false) toast.error("Couldn't reach GitHub. Try again later.")
    } catch (error: any) {
      if (before) setVersionInfo(before)
      toast.error(error.response?.data?.error || 'Failed to save the setting')
    } finally { setBusy(null) }
  }
  const toggle = (on: boolean) => {
    setVersionInfo({ ...info, update_check: on, ...(on ? {} : { latest_release: null, update_available: null }) })
    void act('toggle', () => versionAPI.setCheck(on), info)
  }
  const latest = info.latest_release

  return (
    <div className="card mb-6" data-testid="version-card">
      <div className="p-6 space-y-3">
        <div>
          <h3 className="text-title text-gray-900 mb-1">Version</h3>
          <p className="text-sm text-gray-500">
            While the check is on, Cubex asks GitHub for its latest release once a day. It sends nothing else.
          </p>
        </div>
        <p className="text-sm text-gray-800" data-testid="version-running">
          <span className="font-medium">Running:</span>{' '}
          {info.build ?? (
            <span className="text-gray-500">not recorded (only installs made with the installer record it)</span>
          )}
        </p>
        {latest && (
          <p className="text-sm text-gray-800" data-testid="version-latest">
            <span className="font-medium">Latest release:</span> {latest.version}
            {latest.published_at && <>, {day(latest.published_at)}</>}.{' '}
            <a href={latest.notes_url} target="_blank" rel="noopener noreferrer" className="underline">Release notes</a>
            <span className="text-xs text-gray-500"> (checked {day(latest.checked_at)})</span>
          </p>
        )}
        {latest && info.update_available === true && (
          <p className="flex items-center gap-2 text-sm text-gray-900 font-medium" data-testid="version-update">
            <span className="h-2 w-2 rounded-full bg-cube-black shrink-0" aria-hidden="true" />
            <span>
              {latest.version} is out (you have {info.version}). Run{' '}
              <code className="font-mono whitespace-nowrap">cubex update</code> to get it.
            </span>
          </p>
        )}
        {latest && info.update_available === false && (
          <p className="text-sm text-gray-500" data-testid="version-current">You have the latest release.</p>
        )}
        {latest && !info.build && (
          <p className="text-sm text-gray-500" data-testid="version-how">
            See the <a href={latest.notes_url} target="_blank" rel="noopener noreferrer" className="underline">release
            notes</a> for how to update.
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={info.update_check} disabled={busy !== null}
              data-testid="version-check-toggle"
              onChange={e => toggle(e.target.checked)} />
            Check for new releases
          </label>
          {info.update_check && (
            <button onClick={() => void act('check', versionAPI.checkNow)} disabled={busy !== null}
              className="btn-secondary text-xs whitespace-nowrap flex items-center gap-1"
              data-testid="version-check-now">
              {busy === 'check' && <Loader2 className="h-3 w-3 animate-spin" />}<span>Check now</span>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
