import { useEffect, useState } from 'react'
import { versionAPI, type VersionInfo } from '@/utils/api'

// The version answer, shared by the dashboard's Settings button, the Account tab and the Version card:
// each place that mounts reads it again, and a change the card makes (the check turned off, "Check
// now") reaches the dots at once. Never blocks a page: until it comes, or when it fails, it is null
// and no dot shows.
let latest: VersionInfo | null = null
const listeners = new Set<(v: VersionInfo | null) => void>()

export function setVersionInfo(v: VersionInfo): void {
  latest = v
  for (const fn of listeners) fn(v)
}

export function useVersionInfo(): VersionInfo | null {
  const [info, setInfo] = useState(latest)
  useEffect(() => {
    listeners.add(setInfo)
    versionAPI.get().then(setVersionInfo).catch(() => {})
    return () => { listeners.delete(setInfo) }
  }, [])
  return info
}
