import React, { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { versionAPI, type VersionInfo } from '@/utils/api'
import { setVersionInfo } from '@/hooks/useVersionInfo'

// Settings → Version's "Update now" (server/src/lib/self-update.ts): on an install the installer made, following
// releases, a newer release gets a button. It asks first, then Cubex updates itself as `cubex update` does: it
// stops for a minute or two, and this page asks every 2 seconds until the server answers on the new version, then
// reloads. An update that didn't finish says so, with the update's last lines; the one running before stays. Docker
// builds, source checkouts and pinned installs get the commands to run instead (VersionCard.tsx).
const POLL_MS = 2_000
const LATE_MS = 10 * 60_000
const RECENT_MS = 24 * 60 * 60_000

const recent = (iso: string | null) => !iso || Date.now() - Date.parse(iso) < RECENT_MS

export const VersionUpdate: React.FC<{ info: VersionInfo }> = ({ info }) => {
  const [asking, setAsking] = useState(false)
  const [starting, setStarting] = useState(false)
  const [down, setDown] = useState(false)
  const [late, setLate] = useState(false)
  const run = info.self_update?.run ?? null
  const running = run?.state === 'running'
  const latest = info.latest_release

  // While it runs: ask until the server answers on another version (reload), or says how the update ended.
  useEffect(() => {
    if (!running || !run) return
    const from = run.from
    const began = Date.now()
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      try {
        const next = await versionAPI.get()
        setDown(false)
        if (next.version && next.version !== from) { window.location.reload(); return }
        setVersionInfo(next)
        if (next.self_update?.run?.state !== 'running') return
      } catch {
        setDown(true)
      }
      if (Date.now() - began > LATE_MS) setLate(true)
      if (!stopped) timer = setTimeout(tick, POLL_MS)
    }
    timer = setTimeout(tick, POLL_MS)
    return () => { stopped = true; clearTimeout(timer) }
  }, [running, run?.from, run?.to])

  const start = async () => {
    setStarting(true)
    try {
      setVersionInfo(await versionAPI.update())
      setAsking(false)
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Failed to start the update')
    } finally { setStarting(false) }
  }

  const offer = info.self_update?.how === 'button' && info.update_available === true && latest && !running
  return (
    <>
      {offer && (
        <div className="flex items-center gap-3 pl-4">
          <button onClick={() => setAsking(true)} className="btn-primary text-xs whitespace-nowrap"
            data-testid="version-update-now">
            Update to {latest.version}
          </button>
          <span className="text-xs text-gray-500">or run <code className="font-mono">cubex update</code></span>
        </div>
      )}
      {running && run && (
        <div className="space-y-1" data-testid="version-updating">
          <p className="flex items-center gap-2 text-sm text-gray-900">
            <Loader2 className="h-4 w-4 animate-spin shrink-0" />
            {down
              ? `Updating to ${run.to}: Cubex is restarting. This page reloads once it's back.`
              : `Updating to ${run.to}. Cubex stops for a minute or two.`}
          </p>
          {!down && run.log && (
            <pre className="text-xs text-gray-500 whitespace-pre-wrap pl-6">
              {run.log.split('\n').slice(-3).join('\n')}
            </pre>
          )}
          {late && (
            <p className="text-sm text-gray-700" data-testid="version-update-late">
              Still updating, or it stopped. On the computer Cubex runs on, run{' '}
              <code className="font-mono">cubex status</code>, and see update.log in its folder.
            </p>
          )}
        </div>
      )}
      {run?.state === 'done' && info.version && info.version !== run.from && recent(run.ended_at) && (
        <p className="text-sm text-gray-800" data-testid="version-updated">
          Updated from {run.from} to {info.version}.
        </p>
      )}
      {run?.state === 'failed' && recent(run.ended_at ?? run.started_at) && (
        <div className="space-y-1" data-testid="version-update-failed">
          <p className="text-sm text-gray-900">
            The update to {run.to} didn&apos;t finish. {info.version ?? run.from} is still running, with your data as
            it was.
          </p>
          {run.log && (
            <details className="text-xs text-gray-600">
              <summary className="cursor-pointer">What the update said</summary>
              <pre className="whitespace-pre-wrap mt-1">{run.log}</pre>
            </details>
          )}
        </div>
      )}
      <ConfirmDialog
        isOpen={asking}
        title={`Update to ${latest?.version ?? 'the latest release'}?`}
        message={'Cubex stops for a minute or two while it updates, then this page reloads on the new version. Your '
          + 'data is copied first: if the new version doesn\'t start, the one you have now comes back with your data '
          + 'as it was. Paused runs pick up after.'}
        confirmText="Update now"
        onConfirm={() => void start()}
        onCancel={() => setAsking(false)}
        isLoading={starting}
      />
    </>
  )
}
