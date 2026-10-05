import { api } from './client'
import type {
  AccessToken, AccessTokenScope, APIKey, APIKeySuggestion, CreatedAccessToken,
  OpenRouterKeyTestResult, OpenRouterModel, Settings,
} from './types'

export const settingsAPI = {
  get: (): Promise<Settings> => api.get('/settings').then(res => res.data),

  updateOpenRouterKey: (apiKey: string): Promise<void> =>
    api.put('/settings/openrouter-key', { apiKey }).then(() => {}),

  testOpenRouterKey: (apiKey: string): Promise<OpenRouterKeyTestResult> =>
    api.post('/settings/test-openrouter-key', { apiKey }).then(res => res.data),

  clearOpenRouterKey: (): Promise<void> =>
    api.delete('/settings/openrouter-key').then(() => {}),

  listOpenRouterModels: (): Promise<OpenRouterModel[]> =>
    api.get('/settings/openrouter-models').then(res => res.data),

  // Account-wide default AI model; null clears it.
  updateDefaultModel: (model: string | null): Promise<void> =>
    api.put('/settings/default-model', { model }).then(() => {}),

  // API Keys management
  getAPIKeys: (): Promise<APIKey[]> => api.get('/settings/api-keys').then(res => res.data),

  createAPIKey: (apiKey: Omit<APIKey, 'id' | 'created_at' | 'updated_at'>): Promise<APIKey> =>
    api.post('/settings/api-keys', apiKey).then(res => res.data),

  updateAPIKey: (id: string, apiKey: Omit<APIKey, 'id' | 'created_at' | 'updated_at'>): Promise<APIKey> =>
    api.put(`/settings/api-keys/${id}`, apiKey).then(res => res.data),

  deleteAPIKey: (id: string): Promise<void> =>
    api.delete(`/settings/api-keys/${id}`).then(() => {}),

  getAPIKeySuggestions: (): Promise<APIKeySuggestion[]> =>
    api.get('/settings/api-keys/suggestions').then(res => res.data),

  // Personal access tokens (programmatic /api/v1 + MCP access)
  getAccessTokens: (): Promise<AccessToken[]> =>
    api.get('/settings/access-tokens').then(res => res.data),

  createAccessToken: (body: { name: string; scopes: AccessTokenScope[]; expires_in_days?: number | null }): Promise<CreatedAccessToken> =>
    api.post('/settings/access-tokens', body).then(res => res.data),

  revokeAccessToken: (id: string): Promise<void> =>
    api.delete(`/settings/access-tokens/${id}`).then(() => {}),
}
