// The Linux service (bin/cubex-service.sh, systemd_start) stays down after a Cubex that crashes on every start:
// its unit has a start limit (5 starts in 5 minutes) in [Unit], where systemd reads it; `cubex start` clears a
// failure first (a unit that hit its limit refuses a start until then); and service_gave_up says systemd stopped
// starting it (Result start-limit-hit), for `cubex status`. Against a stand-in systemctl and loginctl on PATH that
// note each call. macOS and Linux only: the script is bash.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

if (process.platform === 'win32') {
  console.log('service-start-limit: skipped on Windows (bash script)')
  process.exit(0)
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'service-limit-'))
const bin = path.join(dir, 'bin')
fs.mkdirSync(bin)
const calls = path.join(dir, 'calls')
fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh
echo "$*" >> "${calls}"
case "$*" in
  *"show -p Result --value"*) echo "\${FAKE_RESULT:-success}" ;;
esac
exit 0
`, { mode: 0o755 })
fs.writeFileSync(path.join(bin, 'loginctl'), '#!/bin/sh\necho yes\n', { mode: 0o755 })

// Sources the script as bin/cubex does and runs `body`; its stdout and exit status.
function inScript(body: string, env: Record<string, string> = {}) {
  const r = spawnSync('bash', ['-c', `set -euo pipefail
say() { echo "$@"; }
die() { echo "$@"; exit 1; }
source "$SCRIPT"
${body}`], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SCRIPT:
    path.resolve('bin/cubex-service.sh'), CUBEX_HOME: dir, APP: '/opt/cubex', LOG: path.join(dir, 'log'),
    CUBEX_SERVICE: 'systemd', XDG_CONFIG_HOME: path.join(dir, 'config'), ...env } })
  return { status: r.status, out: r.stdout, err: r.stderr }
}

let failures = 0
function check(label: string, fn: () => void) {
  try { fn(); console.log('ok  ', label) } catch (e) {
    failures++; console.log('FAIL', label, '\n ', (e as Error).message)
  }
}

try {
  check('the unit has the start limit in [Unit]; a start clears a failure before it restarts', () => {
    const r = inScript('svc_vars; systemd_start')
    assert.equal(r.status, 0, r.err)
    const unit = fs.readFileSync(path.join(dir, 'config', 'systemd', 'user', 'cubex.service'), 'utf8')
    const section = unit.slice(unit.indexOf('[Unit]'), unit.indexOf('[Service]'))
    assert.match(section, /^StartLimitIntervalSec=300$/m)
    assert.match(section, /^StartLimitBurst=5$/m)
    assert.match(unit.slice(unit.indexOf('[Service]')), /^Restart=on-failure$/m)
    const made = fs.readFileSync(calls, 'utf8').split('\n')
    const reset = made.indexOf('--user reset-failed cubex'), restart = made.indexOf('--user restart cubex')
    assert.ok(reset >= 0 && restart > reset, made.join(' | '))
  })

  check('service_gave_up: yes once systemd hit the start limit, no otherwise or outside systemd', () => {
    assert.equal(inScript('service_gave_up', { FAKE_RESULT: 'start-limit-hit' }).status, 0)
    assert.equal(inScript('service_gave_up', { FAKE_RESULT: 'exit-code' }).status, 1)
    assert.equal(inScript('service_gave_up', { FAKE_RESULT: 'start-limit-hit', CUBEX_SERVICE: 'none' }).status, 1)
  })
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}

if (failures > 0) { console.error(`${failures} service-start-limit check(s) failed`); process.exit(1) }
console.log('service-start-limit: all assertions passed')
