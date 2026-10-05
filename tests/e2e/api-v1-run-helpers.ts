import { expect, request as pwRequest, APIRequestContext } from '@playwright/test'
import { BASE, makeAccessToken } from './helpers'

// Shared plumbing for the /api/v1 Phase-2 run specs (api-v1-runs*.spec.ts):
// PAT minting, Bearer contexts, a minimal HTTP-run config, and terminal-status
// polling. HTTP runs hit jsonplaceholder (same live endpoint as
// http-json-only-smoke; the SSRF guard blocks localhost mocks).

export const JSON_URL = 'https://jsonplaceholder.typicode.com/todos/1'

// Delegates to helpers.makeAccessToken, which mints straight into the test DB.
export async function makeToken(api: APIRequestContext, scopes: string[], name: string): Promise<string> {
  return makeAccessToken(api, scopes, name)
}

export function bearer(token: string) {
  return pwRequest.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  })
}

export const httpConfig = (url: string, mappingCol: string, headers: Record<string, string> = {}) => ({
  requestConfig: { method: 'GET', url, headers },
  responseMapping: [{ jsonPath: '$.title', columnName: mappingCol }],
})

export async function waitForTerminal(v1: APIRequestContext, path: string, timeoutMs = 45_000): Promise<any> {
  const deadline = Date.now() + timeoutMs
  let last: any = null
  while (Date.now() < deadline) {
    const res = await v1.get(path)
    expect(res.ok()).toBeTruthy()
    last = await res.json()
    if (['completed', 'failed', 'cancelled'].includes(last.status)) return last
    await new Promise(r => setTimeout(r, 750))
  }
  throw new Error(`run never reached a terminal status: ${JSON.stringify(last)}`)
}
