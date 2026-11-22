// What recording a release's tool list reads and checks (mcp-tool-list-kit.ts recordPlan), the lines kept with
// it (shapes) and the check that they still name the same (linesChanged). A release with lines is recorded
// before its tag, from this checkout's own code, against the release listed before it; a release already out
// is read from its own code. No server and no git here: the releases and tags are given.
import assert from 'node:assert/strict'
import { linesChanged, recordPlan, shapes } from './mcp-tool-list-kit'

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn()
  console.log(`  ok - ${name}`)
}

const TAGS = ['v0.8.39', 'v0.8.38', 'v0.8.37', 'v0.8.32']

await test('the coming release, recorded before its tag: this code, against the list recorded', () => {
  assert.deepEqual(recordPlan('v0.8.40', 'v0.8.38', ['v0.8.40', 'v0.8.38', 'v0.8.32'], TAGS),
    { from: 'here', base: 'v0.8.38', baseFrom: 'file' })
})

await test('the same release again before its tag, or renumbered: against the release before it, from its tag', () => {
  assert.deepEqual(recordPlan('v0.8.40', 'v0.8.40', ['v0.8.40', 'v0.8.38'], TAGS),
    { from: 'here', base: 'v0.8.38', baseFrom: 'tag' })
  assert.deepEqual(recordPlan('v0.9.0', 'v0.8.40', ['v0.9.0', 'v0.8.38'], TAGS),
    { from: 'here', base: 'v0.8.38', baseFrom: 'tag' })
})

await test('a release already out: its own code, against the list recorded', () => {
  assert.deepEqual(recordPlan('v0.8.38', 'v0.8.32', ['v0.8.38', 'v0.8.32'], TAGS),
    { from: 'tag', base: 'v0.8.32', baseFrom: 'file' })
})

await test('refused: what can not be recorded, and why', () => {
  const refused = (release: string, recorded: string, listed: string[], tags = TAGS) => {
    const plan = recordPlan(release, recorded, listed, tags)
    assert.ok('refused' in plan, `${release}: ${JSON.stringify(plan)}`)
    return plan.refused
  }
  assert.match(refused('0.8.40', 'v0.8.38', ['v0.8.40', 'v0.8.38']), /as vX\.Y\.Z/)
  assert.match(refused('v0.8.38', 'v0.8.38', ['v0.8.38']), /not after v0\.8\.38, the release recorded/)
  assert.match(refused('v0.8.40', 'v0.8.38', ['v0.8.40', 'v0.8.38'], []), /no release tags here/)
  // Not the newest release listed: lines for it would go under another number.
  assert.match(refused('v0.8.41', 'v0.8.38', ['v0.8.40', 'v0.8.38']), /not the newest release .* \(v0\.8\.40\)/)
  assert.match(refused('v0.8.40', 'v0.8.38', ['v0.8.38']), /not the newest release .* \(v0\.8\.38\)/)
  // Not after the newest tag (a number skipped): that release can't be cut any more.
  assert.match(refused('v0.8.39', 'v0.8.38', ['v0.8.39', 'v0.8.38'], ['v0.8.40', 'v0.8.38']),
    /not after the newest tag, v0\.8\.40/)
  // The release listed before it isn't out: two releases' lines wait, and one list can't hold both.
  assert.match(refused('v0.8.41', 'v0.8.38', ['v0.8.41', 'v0.8.40', 'v0.8.38']),
    /listed before v0\.8\.41 \(v0\.8\.40\) is not a release tag/)
  assert.match(refused('v0.8.40', 'v0.8.38', ['v0.8.40']), /\(none\) is not a release tag/)
  // The release before it is out with lines but never recorded: that one first.
  assert.match(refused('v0.8.40', 'v0.8.32', ['v0.8.40', 'v0.8.38', 'v0.8.32']),
    /v0\.8\.38 is out with changes for agents and the list recorded is v0\.8\.32's: record v0\.8\.38's first/)
})

await test('the lines kept: change, tools and replaced_by, not the wording', () => {
  assert.deepEqual(shapes([
    { change: 'renamed', tools: ['old'], replaced_by: 'new', summary: 'Old is now new.' } as never,
    { change: 'server', summary: 'The instructions say more.', details: 'Read them.' } as never,
  ]), [{ change: 'renamed', tools: ['old'], replaced_by: 'new' }, { change: 'server' }])
})

await test('the lines recorded still name the same: wording may change, tools and kinds may not', () => {
  const recorded = { release: 'v0.8.40', lines: [{ change: 'changed', tools: ['add_rows'] }], tools: {} }
  const listed = (changes: object[]) => [{ version: 'v0.8.40', changes: changes as never }, { version: 'v0.8.38',
    changes: [{ change: 'added', tools: ['x'] }] as never }]
  assert.equal(linesChanged(recorded, listed([{ change: 'changed', tools: ['add_rows'], summary: 'New words.' }])),
    null)
  for (const changes of [[{ change: 'changed', tools: ['add_rows', 'read_rows'] }], [{ change: 'added', tools:
    ['add_rows'] }], [{ change: 'changed', tools: ['add_rows'] }, { change: 'server' }], []]) {
    assert.match(linesChanged(recorded, listed(changes)) ?? '', /lines for v0\.8\.40 name other changes or tools/)
  }
  // The release recorded no longer listed at all.
  assert.match(linesChanged(recorded, [{ version: 'v0.8.38', changes: [] }]) ?? '', /record it again/)
})

console.log('mcp-tool-list-record: all passed')
