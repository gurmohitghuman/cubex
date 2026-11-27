// A test file ends on its own after its last check: process.exitCode, never process.exit (under load, process.exit
// can hang inside Node's own exit, nodejs/node#54918, open), as mcp-http-kit.ts does. Then nothing may be left
// keeping Node up (a server, a timer, a worker): the file closes what it started, or the runner stops it at its time
// limit and fails it by name. A failing run may still stop at once with process.exit(1): it is red either way.
// A run that stops before passed() with nothing left to wait on (a promise that never settles, outside a top-level
// await) would end with code 0: it fails instead.
let reached = false
process.on('exit', code => {
  if (!reached && code === 0) {
    console.log('FAIL the run stopped before its end')
    process.exitCode = 1
  }
})

// Every check passed: the file ends once what it started has closed.
export function passed(): void {
  reached = true
  process.exitCode = 0
}
