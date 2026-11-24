// Over 200 lines: covers pre-built release archive download, checksum/path guards, fallback, and CI contract.
// Verifies install.sh (POSIX) and install.ps1 (Windows) pre-built archive handling against a local HTTP server,
// plus static workflow and source-fallback contracts.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import zlib from 'node:zlib'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

const WIN = process.platform === 'win32'
const root = fs.mkdtempSync(path.join(path.dirname(process.env.DB_PATH), 'install-prebuilt-'))
const repo = process.cwd()
const shSrc = fs.readFileSync(path.join(repo, 'install.sh'), 'utf8')
const psSrc = fs.readFileSync(path.join(repo, 'install.ps1'), 'utf8')
const relSrc = fs.readFileSync(path.join(repo, '.github', 'workflows', 'release.yml'), 'utf8')

let failures = 0
const ok = async (label: string, fn: () => Promise<void> | void) => {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

const tarEntry = (name: string, body: Buffer): Buffer => {
  const header = Buffer.alloc(512, 0)
  header.write(name, 0, Math.min(Buffer.byteLength(name), 100), 'utf8')
  header.write('0000644\0', 100, 8, 'ascii')
  header.write('0000000\0', 108, 8, 'ascii')
  header.write('0000000\0', 116, 8, 'ascii')
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
  header.write('00000000000\0', 136, 12, 'ascii')
  header.fill(0x20, 148, 156)
  header[156] = '0'.charCodeAt(0)
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  let sum = 0
  for (let i = 0; i < 512; i++) sum += header[i]
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  const pad = (512 - (body.length % 512)) % 512
  return Buffer.concat([header, body, Buffer.alloc(pad, 0)])
}

const makeTarGz = (files: Array<[string, string]>): Buffer => {
  const chunks = files.map(([n, text]) => tarEntry(n, Buffer.from(text, 'utf8')))
  chunks.push(Buffer.alloc(1024, 0))
  return zlib.gzipSync(Buffer.concat(chunks))
}

const makeTarViaCli = (name: string, files: Array<[string, string]>, roots: string[]): Buffer => {
  const stage = path.join(root, `stage-${name}`)
  for (const [rel, text] of files) {
    const dest = path.join(stage, rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, text, 'utf8')
  }
  const out = path.join(root, `${name}.tar.gz`)
  const r = spawnSync('tar', ['-czf', out, '-C', stage, ...roots], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return fs.readFileSync(out)
}

const shaHex = (buf: Buffer) => crypto.createHash('sha256').update(buf).digest('hex')

const validTar = makeTarViaCli('valid', [
  ['server/dist/index.js', 'console.log("server ok");\n'],
  ['server/dist/package.json', '{"type":"commonjs"}\n'],
  ['server/dist/db/migrations/001_schema.sql', 'CREATE TABLE t (id INTEGER PRIMARY KEY);\n'],
  ['client/dist/index.html', '<!doctype html><title>Cubex</title>\n'],
], ['server/dist', 'client/dist'])

const pkgTar = makeTarViaCli('pkg', [
  ['server/dist/index.js', 'console.log("server");\n'],
  ['server/dist/package.json', '{"type":"commonjs"}\n'],
  ['client/dist/index.html', '<!doctype html>\n'],
  ['package.json', '{"name":"hijack"}\n'],
], ['server/dist', 'client/dist', 'package.json'])

const incompleteTar = makeTarViaCli('incomplete', [
  ['server/dist/index.js', 'console.log("server");\n'],
  ['server/dist/package.json', '{"type":"commonjs"}\n'],
], ['server/dist'])

const traversalRootTar = makeTarGz([
  ['../evil.txt', 'nope\n'],
  ['server/dist/index.js', 'console.log("x");\n'],
  ['server/dist/package.json', '{"type":"commonjs"}\n'],
  ['client/dist/index.html', '<!doctype html>\n'],
])

const traversalInnerTar = makeTarGz([
  ['server/dist/../../evil.txt', 'nope\n'],
  ['server/dist/index.js', 'console.log("x");\n'],
  ['server/dist/package.json', '{"type":"commonjs"}\n'],
  ['client/dist/index.html', '<!doctype html>\n'],
])

let handler: (url: string, res: http.ServerResponse) => void = (_u, res) => { res.statusCode = 404; res.end() }
let requests: string[] = []
const server = http.createServer((req, res) => {
  const url = req.url ?? '/'
  requests.push(url)
  handler(url, res)
})

const runAsync = (cmd: string, args: string[]) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('error', reject)
    child.on('close', status => resolve({ status, stdout, stderr }))
  })

let invokeRunner: (baseUrl: string, ref: string, nextDir: string) =>
  Promise<{ status: number | null; stdout: string; stderr: string }>

if (!WIN) {
  const tail = '\nmain "$@"\n'
  assert.ok(shSrc.endsWith(tail), 'install.sh ends with main "$@"')
  const libPath = path.join(root, 'install-lib.sh')
  const runnerPath = path.join(root, 'run-prebuilt.sh')
  fs.writeFileSync(libPath, shSrc.slice(0, -tail.length) + '\n', 'utf8')
  fs.writeFileSync(runnerPath, [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '. "$1"',
    'TMP="$2"',
    'CUBEX_REPO="gurmohitghuman/cubex"',
    'CUBEX_DIST_URL="$3"',
    'PREBUILT=0',
    'fetch_prebuilt "$4" "$5"',
    'printf "PREBUILT=%s\\n" "$PREBUILT"',
    '',
  ].join('\n'), { mode: 0o700 })
  invokeRunner = (baseUrl, ref, nextDir) => {
    const tmpDir = fs.mkdtempSync(path.join(root, 'tmp-'))
    return runAsync('bash', [runnerPath, libPath, tmpDir, baseUrl, ref, nextDir])
  }
} else {
  const marker = '$savedHome = $env:CUBEX_HOME'
  const idx = psSrc.indexOf(marker)
  assert.ok(idx > 0, 'install.ps1 holds $savedHome = $env:CUBEX_HOME')
  const runnerPath = path.join(root, 'run-prebuilt.ps1')
  const body = [
    psSrc.slice(0, idx),
    '$ErrorActionPreference = "Stop"',
    '$S.Died = $false',
    '$Tmp = $args[0]',
    '$Repo = "gurmohitghuman/cubex"',
    '$env:CUBEX_DIST_URL = $args[1]',
    'try {',
    '  $res = Get-Prebuilt $(if ($args[2] -eq "-") { "" } else { $args[2] }) $args[3]',
    '  Write-Output ("PREBUILT=" + ($(if ($res) { "1" } else { "0" })))',
    '} catch {',
    '  [Console]::Error.WriteLine($_.Exception.Message)',
    '  exit 1',
    '}',
    '} $args[0] $args[1] $args[2] $args[3]',
    '',
  ].join('\r\n')
  fs.writeFileSync(runnerPath, body, 'utf8')
  const psFlags = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']
  invokeRunner = (baseUrl, ref, nextDir) => {
    const tmpDir = fs.mkdtempSync(path.join(root, 'tmp-'))
    // No tag goes as "-": an empty argument may not reach a script run with -File.
    return runAsync('powershell.exe', [...psFlags, runnerPath, tmpDir, baseUrl, ref || '-', nextDir])
  }
}

const makeNext = (name: string) => {
  const d = path.join(root, `next-${name}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}

const run = async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as { port: number }
  const baseUrl = `http://127.0.0.1:${addr.port}`

  await ok('downloads, verifies uppercase CRLF sha256, unpacks server/dist and client/dist cleanly', async () => {
    const digest = shaHex(validTar).toUpperCase()
    handler = (u, res) => {
      if (u === '/cubex-dist.tar.gz.sha256') { res.end(`\uFEFF${digest}  *cubex-dist.tar.gz\r\n`); return }
      if (u === '/cubex-dist.tar.gz') { res.end(validTar); return }
      res.statusCode = 404; res.end()
    }
    const next = makeNext('valid')
    const r = await invokeRunner(baseUrl, 'v0.9.0', next)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /PREBUILT=1/)
    assert.ok(fs.existsSync(path.join(next, 'server', 'dist', 'index.js')))
    assert.ok(fs.existsSync(path.join(next, 'server', 'dist', 'package.json')))
    assert.ok(fs.existsSync(path.join(next, 'server', 'dist', 'db', 'migrations', '001_schema.sql')))
    assert.ok(fs.existsSync(path.join(next, 'client', 'dist', 'index.html')))
    assert.ok(!fs.existsSync(path.join(next, '.dist-stage')), '.dist-stage removed')
  })

  await ok('falls back when older release returns 404 for checksum file', async () => {
    requests = []
    handler = (_u, res) => { res.statusCode = 404; res.end('Not Found') }
    const next = makeNext('404')
    const r = await invokeRunner(baseUrl, 'v0.8.0', next)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /PREBUILT=0/)
    assert.deepEqual(requests, ['/cubex-dist.tar.gz.sha256'])
    assert.ok(!fs.existsSync(path.join(next, 'server', 'dist')))
  })

  await ok('skips network lookup and falls back for non-release refs', async () => {
    for (const ref of ['main', 'abc1234', 'v0.9.0-beta', 'v1.2']) {
      requests = []
      const next = makeNext(`ref-${ref.replace(/[^a-z0-9]/gi, '_')}`)
      const r = await invokeRunner(baseUrl, ref, next)
      assert.equal(r.status, 0, `${ref}: ${r.stderr}`)
      assert.match(r.stdout, /PREBUILT=0/)
      assert.equal(requests.length, 0, `${ref} should make zero HTTP requests`)
    }
  })

  await ok('fails when archive sha256 mismatches and leaves target untouched', async () => {
    handler = (u, res) => {
      if (u === '/cubex-dist.tar.gz.sha256') { res.end(`${'0'.repeat(64)}  cubex-dist.tar.gz\n`); return }
      if (u === '/cubex-dist.tar.gz') { res.end(validTar); return }
      res.statusCode = 404; res.end()
    }
    const next = makeNext('bad-hash')
    const r = await invokeRunner(baseUrl, 'v0.9.0', next)
    assert.notEqual(r.status, 0)
    assert.match(r.stderr + r.stdout, /checksum/i)
    assert.ok(!fs.existsSync(path.join(next, 'server', 'dist')))
  })

  await ok('fails when checksum file is malformed', async () => {
    for (const content of ['not-a-hash  cubex-dist.tar.gz\n', `${'a'.repeat(64)}  other.tar.gz\n`, '\n']) {
      handler = (_u, res) => res.end(content)
      const next = makeNext('bad-sum')
      const r = await invokeRunner(baseUrl, 'v0.9.0', next)
      assert.notEqual(r.status, 0)
      assert.match(r.stderr + r.stdout, /checksum file was invalid/i)
    }
  })

  await ok('rejects unexpected paths, path traversal, and incomplete archives', async () => {
    const cases: Array<[string, Buffer, RegExp]> = [
      ['pkg-json', pkgTar, /unexpected file/i],
      ['trav-root', traversalRootTar, /unexpected file/i],
      ['trav-inner', traversalInnerTar, /unexpected|unsafe path/i],
      ['incomplete', incompleteTar, /incomplete/i],
    ]
    for (const [name, archive, msg] of cases) {
      const digest = shaHex(archive)
      handler = (u, res) => {
        if (u === '/cubex-dist.tar.gz.sha256') { res.end(`${digest}  cubex-dist.tar.gz\n`); return }
        if (u === '/cubex-dist.tar.gz') { res.end(archive); return }
        res.statusCode = 404; res.end()
      }
      const next = makeNext(name)
      const r = await invokeRunner(baseUrl, 'v0.9.0', next)
      assert.notEqual(r.status, 0, `${name} should fail`)
      assert.match(r.stderr + r.stdout, msg, `${name}: ${r.stderr}`)
      assert.ok(!fs.existsSync(path.join(next, 'package.json')))
      assert.ok(!fs.existsSync(path.join(next, 'server', 'dist')))
      assert.ok(!fs.existsSync(path.join(next, '.dist-stage')))
    }
  })

  // An install from --source with CUBEX_DIST_URL (the Release workflow's install from the archive it attaches) has
  // no tag: it takes the archive there.
  const serve = (archive: Buffer) => {
    const digest = shaHex(archive)
    handler = (u, res) => {
      if (u === '/cubex-dist.tar.gz.sha256') { res.end(`${digest}  cubex-dist.tar.gz\n`); return }
      if (u === '/cubex-dist.tar.gz') { res.end(archive); return }
      res.statusCode = 404; res.end()
    }
  }
  await ok('with no tag (--source), takes the archive at CUBEX_DIST_URL', async () => {
    serve(validTar)
    requests = []
    const next = makeNext('no-tag')
    const r = await invokeRunner(baseUrl, '', next)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /PREBUILT=1/)
    assert.match(r.stdout, new RegExp(`Downloaded pre-built Cubex \\(${baseUrl}\\)`))
    assert.deepEqual(requests, ['/cubex-dist.tar.gz.sha256', '/cubex-dist.tar.gz'])
    assert.ok(fs.existsSync(path.join(next, 'server', 'dist', 'index.js')))
  })

  // tar run as root keeps an archive's owners: the release packs every entry as root's (scripts/pack-dist.sh), and
  // install.sh unpacks as the installing user whatever the archive says. Linux only: GNU tar packs the release, and
  // fakeroot plays root without being it.
  const gnuTar = !WIN && /GNU tar/.test(spawnSync('tar', ['--version'], { encoding: 'utf8' }).stdout ?? '')
  const fakeroot = !WIN && spawnSync('fakeroot', ['true']).status === 0
  await ok('the release packs every entry as root\'s', () => {
    if (!gnuTar) { console.log('     (skipped: no GNU tar here)'); return }
    const stage = path.join(root, 'pack')
    for (const [rel, text] of [['server/dist/index.js', 'x\n'], ['server/dist/package.json', '{}\n'],
      ['server/dist/db/migrations/001_schema.sql', '\n'], ['client/dist/index.html', '<!doctype html>\n']]) {
      fs.mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true })
      fs.writeFileSync(path.join(stage, rel), text)
    }
    const r = spawnSync('bash', [path.join(repo, 'scripts', 'pack-dist.sh'), 'out'], { cwd: stage, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr + r.stdout)
    const list = spawnSync('tar', ['--numeric-owner', '-tvzf', path.join(stage, 'out', 'cubex-dist.tar.gz')],
      { encoding: 'utf8' }).stdout.trim().split('\n')
    assert.ok(list.length >= 8, list.join('\n'))
    assert.deepEqual([...new Set(list.map(l => l.split(/\s+/)[1]))], ['0/0'], list.join('\n'))
    const sum = fs.readFileSync(path.join(stage, 'out', 'cubex-dist.tar.gz.sha256'), 'utf8')
    assert.equal(sum, `${shaHex(fs.readFileSync(path.join(stage, 'out', 'cubex-dist.tar.gz')))}  cubex-dist.tar.gz\n`)
  })
  await ok('installed as root, the files are root\'s, not the archive\'s owner', async () => {
    if (!gnuTar || !fakeroot) { console.log('     (skipped: needs GNU tar and fakeroot)'); return }
    const stage = path.join(root, 'stage-owned')
    for (const [rel, text] of [['server/dist/index.js', 'x\n'], ['server/dist/package.json', '{}\n'],
      ['client/dist/index.html', '<!doctype html>\n']]) {
      fs.mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true })
      fs.writeFileSync(path.join(stage, rel), text)
    }
    const owned = path.join(root, 'owned.tar.gz')
    const packed = spawnSync('tar', ['--owner=1001', '--group=1001', '--numeric-owner', '-czf', owned, '-C', stage,
      'server/dist', 'client/dist'], { encoding: 'utf8' })
    assert.equal(packed.status, 0, packed.stderr)
    serve(fs.readFileSync(owned))
    const next = makeNext('as-root')
    const tmpDir = fs.mkdtempSync(path.join(root, 'tmp-'))
    const r = await runAsync('fakeroot', ['--', 'bash', '-c',
      'bash "$1" "$2" "$3" "$4" "" "$5" && find "$5/server" "$5/client" -printf "%U:%G\\n" | sort -u',
      '_', path.join(root, 'run-prebuilt.sh'), path.join(root, 'install-lib.sh'), tmpDir, baseUrl, next])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /PREBUILT=1/)
    assert.deepEqual(r.stdout.split('\n').filter(l => /^\d+:\d+$/.test(l)), ['0:0'], r.stdout)
  })

  await ok('installer and release workflow source-build and prebuilt contracts hold', () => {
    assert.match(shSrc, /PREBUILT=0[\s\S]*npm ci --omit=dev --no-audit --no-fund/)
    assert.match(shSrc, /npm ci --include=dev --no-audit --no-fund && npm run build && npm prune --omit=dev/)
    assert.match(psSrc, /\$S\.Prebuilt[\s\S]*npm ci --omit=dev --no-audit --no-fund/)
    assert.match(psSrc, /npm ci --include=dev --no-audit --no-fund && npm run build && npm prune --omit=dev/)
    assert.match(relSrc, /build-dist:[\s\S]*npm run build[\s\S]*cubex-dist\.tar\.gz\.sha256/)
    assert.match(relSrc,
      /needs:\s*\[resolve,\s*ci,\s*build-dist,\s*install-dist,\s*install,\s*install-windows,\s*install-unix\]/)
    assert.match(relSrc, /install-dist:[\s\S]*uses: \.\/\.github\/workflows\/install-dist\.yml[\s\S]*artifact: true/)
    assert.match(relSrc, /build-dist:[\s\S]*bash scripts\/pack-dist\.sh release-assets/)
    assert.match(relSrc, /sha256sum -c cubex-dist\.tar\.gz\.sha256[\s\S]*gh release upload[\s\S]*--draft=false/)
  })
}

run()
  .catch(e => { failures++; console.log('FAIL unhandled error\n ', (e as Error).stack) })
  .finally(() => {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
    if (failures > 0) process.exitCode = 1
  })
