// actionFieldsProblem (server/src/mcp/action-fields.ts), each merged tool's check of what goes with its action: an
// action missing or unknown is refused by name with the actions there are (it was a TypeError an agent saw as
// "Cannot read properties of undefined"), a field for another action is refused, a needed field missing is named.
import assert from 'node:assert/strict'
import mod from '../../server/src/mcp/action-fields'
import { passed } from './ends-on-its-own'
const { actionFieldsProblem } = mod as typeof import('../../server/src/mcp/action-fields')

const takes = { list: { may: ['limit'] }, status: { needs: ['run_id'] } } as const
const check = (action: string, given: Record<string, unknown>) =>
  actionFieldsProblem(action as 'list' | 'status', given, takes as never)

assert.equal(check(undefined as unknown as string, {}), 'action is needed: one of list, status.')
assert.equal(check('nope', {}), 'action is needed: one of list, status.')
assert.equal(check('toString', {}), 'action is needed: one of list, status.', 'not an Object.prototype member')
assert.equal(check('status', {}), 'status needs run_id.')
assert.equal(check('list', { run_id: 'x' }), 'run_id is not for list: it takes limit.')
assert.equal(check('status', { run_id: 'x' }), null)
console.log('All action-fields checks passed.')
passed()
