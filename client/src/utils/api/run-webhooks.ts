import { api } from './client'

// "Run finished" webhooks (Settings, Run webhooks): URLs told when a run ends.
export interface RunWebhookDelivery {
  id: string
  event: 'run.finished' | 'test'
  run_id: string | null
  kind: 'ai' | 'http' | 'enrichment' | 'setup' | null
  run_status: 'completed' | 'failed' | 'cancelled' | null
  state: 'pending' | 'sending' | 'delivered' | 'failed'
  tries: number
  response_code: number | null
  error: string | null
  created_at: string
  finished_at: string | null
}

export interface RunWebhook {
  id: string
  url: string
  every_run: boolean
  created_at: string
  updated_at: string
  last_delivery: Pick<RunWebhookDelivery, 'state' | 'response_code' | 'error' | 'created_at'> | null
}

export const runWebhooksAPI = {
  list: (): Promise<RunWebhook[]> =>
    api.get('/settings/run-webhooks').then(res => res.data.webhooks),

  // The secret comes back this once.
  create: (url: string, everyRun: boolean): Promise<{ webhook: RunWebhook; secret: string }> =>
    api.post('/settings/run-webhooks', { url, every_run: everyRun }).then(res => res.data),

  update: (id: string, patch: { url?: string; every_run?: boolean }): Promise<RunWebhook> =>
    api.patch(`/settings/run-webhooks/${id}`, patch).then(res => res.data),

  newSecret: (id: string): Promise<string> =>
    api.post(`/settings/run-webhooks/${id}/secret`).then(res => res.data.secret),

  remove: (id: string): Promise<void> =>
    api.delete(`/settings/run-webhooks/${id}`).then(() => {}),

  deliveries: (id: string): Promise<RunWebhookDelivery[]> =>
    api.get(`/settings/run-webhooks/${id}/deliveries`).then(res => res.data.deliveries),

  test: (id: string): Promise<RunWebhookDelivery> =>
    api.post(`/settings/run-webhooks/${id}/test`).then(res => res.data),
}
