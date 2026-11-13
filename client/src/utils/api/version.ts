import { api } from './client'

// Settings → Account → Version (server routes/settings-version.ts, services/version-info.ts). Field
// names match GET /api/v1/version and MCP get_version.
export interface VersionInfo {
  version: string | null       // the running release ("v0.8.12"); null: a branch, a local source, not recorded
  build: string | null         // the build as the installer recorded it; null: not recorded (Docker)
  update_check: boolean
  latest_release: { version: string; published_at: string | null; notes_url: string; checked_at: string } | null
  update_available: boolean | null
}

// The Version card says what went wrong itself.
const quiet = { skipServerErrorToast: true } as const

export const versionAPI = {
  get: (): Promise<VersionInfo> => api.get('/settings/version', quiet).then(res => res.data),
  setCheck: (on: boolean): Promise<VersionInfo> =>
    api.put('/settings/version', { update_check: on }, quiet).then(res => res.data),
  checkNow: (): Promise<VersionInfo & { reached: boolean }> =>
    api.post('/settings/version/check', {}, quiet).then(res => res.data),
}
