import { api } from './client'

export interface AuthStatus {
  // True on a fresh install: no password has been chosen yet.
  setupRequired: boolean
  authenticated: boolean
}

// Cookie auth: the server sets and clears the HttpOnly session cookie, so no
// token ever passes through here. The app derives its state from /auth/status.
export const authAPI = {
  status: (): Promise<AuthStatus> =>
    api.get('/auth/status').then(res => res.data),

  setup: (password: string): Promise<void> =>
    api.post('/auth/setup', { password }).then(() => {}),

  login: (password: string): Promise<void> =>
    api.post('/auth/login', { password }).then(() => {}),

  logout: (): Promise<void> =>
    api.post('/auth/logout').then(() => {}),

  changePassword: (currentPassword: string, newPassword: string): Promise<void> =>
    api.post('/auth/change-password', { currentPassword, newPassword }).then(() => {}),
}
