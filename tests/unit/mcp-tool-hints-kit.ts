// Shared fixture for the tool hint tests (mcp-tool-hints, mcp-tool-hints-writes):
// a migrated throwaway database, one account and table, sheets of rows, every
// MCP tool captured as registerAllTools registers it (one set per token scope
// list, since a tool closes over its caller), and a snapshot of every row,
// sheet and setup to compare before and after a call.
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import buildMod from '../../server/src/mcp/build-server'
import annMod from '../../server/src/mcp/tool-annotations'
import viewMod from '../../server/src/services/view-store'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { registerAllTools } = buildMod as typeof import('../../server/src/mcp/build-server')
const { TOOL_ANNOTATIONS } = annMod as typeof import('../../server/src/mcp/tool-annotations')
const { createDefaultView } = viewMod as typeof import('../../server/src/services/view-store')

type Answer = { isError?: boolean; content?: Array<{ text?: string }> }
type Handler = (args: unknown, extra: unknown) => Promise<Answer>
type Row = { id: string; sheet_id: string; row_index: number; data: string }

export function toolHintsKit(name: string) {
  if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
  runMigrations()
  console.warn = () => {}
  const uid = uuid(), tid = uuid()
  db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
  db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
  db.prepare(`INSERT INTO access_tokens (id, user_id, name, token_hash, token_prefix, scopes)
    VALUES ('tok', ?, 'unit', 'h-tok', 'cubex_pat_x', 'read,write,run,secrets')`).run(uid)
  let failures = 0, position = 0
  const check = async (label: string, fn: () => void | Promise<void>) => {
    try { await fn(); console.log('ok  ', label) }
    catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
  }
  const done = () => {
    if (failures) { console.error(`${failures} ${name} check(s) failed`); process.exit(1) }
    console.log(`All ${name} assertions passed.`)
    process.exit(0)
  }
  const crash = (e: unknown) => { console.error(e); process.exit(1) }

  // A sheet of rows, with the Default view the app makes with every sheet.
  const sheet = (sheetName: string, columns: string[], rows: Array<Record<string, string>>) => {
    const id = uuid()
    db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,?,?)')
      .run(id, tid, uid, sheetName, position++, JSON.stringify(columns))
    createDefaultView(id, uid)
    const ins = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
    rows.forEach((r, i) => ins.run(uuid(), id, uid, i, JSON.stringify(r)))
    return id
  }

  const sets = new Map<string, Map<string, Handler>>()
  function toolsFor(scopes: readonly string[]): Map<string, Handler> {
    const key = [...scopes].sort().join(',')
    let found = sets.get(key)
    if (!found) {
      const into = new Map<string, Handler>()
      const standIn = { registerTool(tool: string, _config: unknown, handler: Handler) { into.set(tool, handler) } }
      registerAllTools(standIn as never, { userId: uid, tokenId: 'tok', tokenName: 'unit', scopes: new Set(scopes),
        spend: null, linkBase: 'http://127.0.0.1:1' } as never)
      sets.set(key, found = into)
    }
    return found
  }
  const tools = toolsFor(['read'])
  const extra = { signal: new AbortController().signal, mcpReq: { signal: new AbortController().signal } }
  // The tool's first text block, "ERROR " in front when it refused.
  async function call(tool: string, args: Record<string, unknown>, scopes: readonly string[]): Promise<string> {
    const handler = toolsFor(scopes).get(tool)
    if (!handler) throw new Error(`no tool ${tool}`)
    try {
      const answer = await handler(args, extra)
      return `${answer.isError ? 'ERROR ' : ''}${answer.content?.[0]?.text ?? JSON.stringify(answer)}`
    } catch (e) { return `ERROR thrown: ${(e as Error).message}` }
  }

  const snapshot = () => ({
    rows: db.prepare('SELECT id, sheet_id, row_index, data FROM rows ORDER BY sheet_id, row_index').all() as Row[],
    sheets: db.prepare('SELECT id, name, column_order FROM sheets ORDER BY id').all(),
    setups: db.prepare('SELECT * FROM setups ORDER BY id').all(),
  })
  return { db, uid, tid, sheet, tools, call, hints: TOOL_ANNOTATIONS, snapshot, check, done, crash }
}
