import { api } from './client'

// Settings → Account → Version (server routes/settings-version.ts, services/version-info.ts). Field
// names match GET /api/v1/version and MCP get_account (action version).
export interface VersionInfo {
  version: string | null       // the running release ("v0.8.12"); null: a branch, a local source, not recorded
  build: string | null         // the build as the installer recorded it; null: not recorded (Docker)
  pinned_ref: string | null    // an install made with --ref stays on it (cubex update reinstalls it)
  update_check: boolean
  latest_release: { version: string; published_at: string | null; notes_url: string; checked_at: string } | null
  update_available: boolean | null
  // Settings' own answer only (not GET /v1/version): how this install updates, and the last update started from
  // Settings (server/src/lib/self-update.ts).
  self_update?: SelfUpdate
}

export interface UpdateRun {
  state: 'running' | 'done' | 'failed'
  from: string
  to: string
  started_at: string | null
  ended_at: string | null
  code: number | null  // the update's exit code; null when the updater stopped without saying
  log: string          // the update's last lines
}

// button: an install the installer made, following releases; otherwise the card says what to run.
export interface SelfUpdate { how: 'button' | 'pinned' | 'docker' | 'source'; run: UpdateRun | null }

// The Version card says what went wrong itself.
const quiet = { skipServerErrorToast: true } as const

export const versionAPI = {
  get: (): Promise<VersionInfo> => api.get('/settings/version', quiet).then(res => res.data),
  setCheck: (on: boolean): Promise<VersionInfo> =>
    api.put('/settings/version', { update_check: on }, quiet).then(res => res.data),
  // asked false: a check went out under a minute ago, and this is what it found.
  checkNow: (): Promise<VersionInfo & { reached: boolean; asked: boolean }> =>
    api.post('/settings/version/check', {}, quiet).then(res => res.data),
  // Starts the update to the latest release the check found; Cubex stops for it a moment later.
  update: (): Promise<VersionInfo> => api.post('/settings/version/update', {}, quiet).then(res => res.data),
}
