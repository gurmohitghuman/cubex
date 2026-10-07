// How the user's treg team is served for one tool, for Set up's provider
// badges: their own key, a free route, or treg's key, per provider for a
// waterfall. treg's plan leaves out providers that can't take the tool's
// example input, so those are asked about one by one (lib/enrich-access.ts),
// all at once: a waterfall has a few dozen providers at most, and each read
// has treg's 10 s timeout, so the answer comes well inside the client's 30 s.
// A complete answer is cached briefly per key and tool (the drawer reads this
// each time it opens); one with a read that failed isn't, so the next open asks again.
import { createHash } from 'node:crypto'
import { readToolAccess, type ToolAccess } from '../lib/treg'
import { accessRow, missingProviders, withRows } from '../lib/enrich-access'
import { TREG_ACCESS_CACHE_MS, TREG_ACCESS_CACHE_MAX_ENTRIES } from '../lib/constants'
import { getTool } from './enrich-catalog'
import { getTregToken } from './treg-key'

export type AccessRead = { ok: ToolAccess } | { fail: 'no_key' | 'unavailable'; message: string }

const cache = new Map<string, { at: number; value: ToolAccess }>()

function remember(key: string, value: ToolAccess): void {
  cache.delete(key)
  cache.set(key, { at: Date.now(), value })
  while (cache.size > TREG_ACCESS_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

// complete: every provider the plan left out answered.
async function completeWaterfall(token: string, toolId: string, access: ToolAccess): Promise<{ access: ToolAccess; complete: boolean }> {
  if (access.tier !== 'routed') return { access, complete: true }
  const tool = await getTool(toolId)
  if (!('ok' in tool) || !tool.ok.providers) return { access, complete: false }
  const missing = missingProviders(tool.ok.providers, access.plan)
  const rows = await Promise.all(missing.map(async m => accessRow(m.provider, m.endpointId, await readToolAccess(token, m.endpointId))))
  return { access: withRows(access, rows), complete: rows.every(r => r !== null) }
}

export async function toolAccess(userId: string, toolId: string): Promise<AccessRead> {
  const token = getTregToken(userId)
  if (!token) return { fail: 'no_key', message: 'Add your treg key in Settings first.' }
  // Keyed by a hash of the key, so a new key in Settings reads fresh.
  const key = `${createHash('sha256').update(token).digest('hex').slice(0, 16)}:${toolId}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TREG_ACCESS_CACHE_MS) return { ok: hit.value }
  const access = await readToolAccess(token, toolId)
  if (!access) return { fail: 'unavailable', message: "Couldn't read this tool's access from treg." }
  const done = await completeWaterfall(token, toolId, access)
  if (done.complete) remember(key, done.access)
  return { ok: done.access }
}

// Test hook.
export function clearAccessCache(): void { cache.clear() }
