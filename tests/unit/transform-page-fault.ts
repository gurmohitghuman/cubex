// A failing page for transform_column tests (services/column-transform-pages.ts): once armed with n, the n-th
// row a call's pages write throws (251: the first row of its second page), so that page rolls back. db.prepare is
// wrapped on the app's own connection: the app prepares its page statement at run time, so its code is unchanged.
import type Database from 'better-sqlite3'

export function transformPageFault(db: Database.Database) {
  const prepare = db.prepare.bind(db)
  let throwAt = 0
  db.prepare = ((sql: string) => {
    const stmt = prepare(sql)
    if (!throwAt || !sql.startsWith('UPDATE rows SET data = json_set(data, ?, ?)')) return stmt
    const run = stmt.run.bind(stmt)
    let n = 0
    Object.assign(stmt, { run: (...a: unknown[]) => {
      if (++n === throwAt) throw new Error('disk on fire at /var/secret/path')
      return run(...a)
    } })
    return stmt
  }) as typeof db.prepare
  return { arm(n: number) { throwAt = n }, disarm() { throwAt = 0 } }
}
