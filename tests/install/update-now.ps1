# Settings' "Update now" for real, on Windows: update-now.sh's twin (.github/workflows/update-now.yml;
# plans/settings-update-now.md's must-pass). The commit under test is installed from its checkout with the installer,
# then labeled the release before the latest and set to follow releases, so the button offers the latest. Through the
# API, as the page does, with a session (never a token):
# 1. An update whose new version doesn't start: install.env's CUBEX_SOURCE points `cubex update` at a copy of the
#    checkout whose server exits at start. The installer must put the version before back with the data as it was,
#    and Settings must say the update failed, with what it said.
# 2. An update that comes through: CUBEX_SOURCE points `cubex update` at a newer build of the commit (a local commit
#    on top). Cubex must come back on it, the updater must have written exit code 0, and the password and a sheet
#    made before must read back as they were. Not the latest release: this commit can hold a migration that release
#    doesn't, and an older build refuses a newer database (update-now.sh says more).
# Nothing is pushed or tagged. Usage: tests\install\update-now.ps1 <checkout>; CUBEX_HOME and TEST_PORT may be set
# (by default a new folder under the temp folder, and port 3002).
param([Parameter(Mandatory = $true)][string]$Checkout)
$ErrorActionPreference = 'Stop'
$Src = (Resolve-Path $Checkout).Path
$Work = Join-Path ([IO.Path]::GetTempPath()) "cubex-update-now-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
New-Item -ItemType Directory -Path $Work | Out-Null
if (-not $env:CUBEX_HOME) { $env:CUBEX_HOME = Join-Path $Work 'home' }
$CubexHome = $env:CUBEX_HOME
$Port = if ($env:TEST_PORT) { $env:TEST_PORT } else { '3002' }
$Url = "http://127.0.0.1:$Port"
$Password = 'update-now-password'
$ReleaseRepo = if ($env:RELEASE_REPO) { $env:RELEASE_REPO } else { 'gurmohitghuman/cubex' }
$Cli = Join-Path $CubexHome 'bin\cubex.cmd'
$web = New-Object Microsoft.PowerShell.Commands.WebRequestSession # keeps the session cookie
# On a failure: what went wrong, then what the update and Cubex wrote (the last update's status and log, Cubex's log).
trap {
  "::error::$_"
  foreach ($f in 'update-status.json', 'update.log', 'logs\cubex.log') {
    "--- $f"; Get-Content (Join-Path $CubexHome $f) -Tail 60 -ErrorAction SilentlyContinue
  }
  # The stand-in and Cubex stopped, so a run after this one finds its ports free.
  if ($script:standin) { Stop-Process -Id $script:standin.Id -ErrorAction SilentlyContinue }
  if (Test-Path $Cli) { & $Cli stop *> $null }
  break
}

function Step([string]$What) { ''; "== $What" }
# One request; an error status is an answer here, not an exception. A body goes as UTF-8 JSON.
function Send([string]$Method, [string]$Path, $Body = $null, [hashtable]$Headers = @{}, $Session = $web) {
  $call = @{ UseBasicParsing = $true; Method = $Method; Uri = "$Url$Path"; Headers = $Headers; TimeoutSec = 60 }
  if ($Session) { $call.WebSession = $Session }
  if ($null -ne $Body) {
    $call.ContentType = 'application/json; charset=utf-8'
    $call.Body = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $Body -Compress -Depth 10))
  }
  try { $res = Invoke-WebRequest @call; $status = [int]$res.StatusCode; $text = "$($res.Content)" }
  catch {
    if (-not $_.Exception.Response) { throw } # no answer at all
    $status = [int]$_.Exception.Response.StatusCode
    $text = "$($_.ErrorDetails.Message)"
  }
  $json = $null
  if ($text) { try { $json = ConvertFrom-Json -InputObject $text } catch { } }
  [pscustomobject]@{ Status = $status; Body = $text; Json = $json }
}
# The answer's JSON when it has the expected status; otherwise stop, saying what came back.
function Need($Answer, [int]$Status, [string]$What) {
  Write-Host "$What -> $($Answer.Status)"
  if ($Answer.Status -ne $Status) { throw "$What answered $($Answer.Status), expected $Status. Body: $($Answer.Body)" }
  $Answer.Json
}
# The sheet as the API token reads it: its name, row count and columns, then every row (values as JSON).
function Get-SheetLines([string]$SheetId, [hashtable]$Auth) {
  $sheet = Need (Send GET "/api/v1/sheets/$SheetId" -Headers $Auth -Session $null) 200 "GET /api/v1/sheets/$SheetId"
  $page = Need (Send GET "/api/v1/sheets/$SheetId/rows?limit=100" -Headers $Auth -Session $null) 200 `
    "GET /api/v1/sheets/$SheetId/rows"
  $columns = [string[]]@($sheet.columns)
  "sheet '$($sheet.name)', $($sheet.row_count) rows, columns: $($columns -join ', ')"
  foreach ($row in @($page.rows)) {
    $cells = foreach ($c in $columns) { "$c=$(ConvertTo-Json -Compress -InputObject ([string]($row.data.$c)))" }
    "row $($row.id) at $($row.index): $($cells -join ' ')"
  }
}
function Sign-In {
  $script:web = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  Need (Send POST /api/auth/login @{ password = $Password }) 200 'POST /api/auth/login' | Out-Null
}
# Healthy, the password signs in (a wrong one gets 401), and the sheet reads back as it did before.
function Assert-AsBefore {
  $health = Need (Send GET /api/health) 200 'GET /api/health'
  if ($health.status -ne 'ok') { throw "Cubex answers, but isn't healthy: $($health | ConvertTo-Json -Compress)" }
  $fresh = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  Need (Send POST /api/auth/login @{ password = "$Password-wrong" } -Session $fresh) 401 `
    'POST /api/auth/login with a wrong password' | Out-Null
  Sign-In
  $now = @(Get-SheetLines $script:SheetId $script:Auth)
  $now | ForEach-Object { "  $_" }
  if (Compare-Object $script:Before $now -SyncWindow 0) { throw 'The sheet reads back differently from before.' }
}
function Installed { "Installed: $((Get-Content -Raw (Join-Path $CubexHome 'app\.cubex-version')).Trim())" }
function Get-Status {
  $p = Join-Path $CubexHome 'update-status.json'
  if (Test-Path $p) { Get-Content -Raw $p | ConvertFrom-Json } else { [pscustomobject]@{} }
}
# install.env's line for `name`, as install.ps1 writes it (name=value, CRLF).
function Set-InstallEnv([string]$Name, [string]$Value) {
  $p = Join-Path $CubexHome 'install.env'
  $text = [IO.File]::ReadAllText($p) -replace "(?m)^$Name=.*?(\r?)$", "$Name=$Value`$1"
  [IO.File]::WriteAllText($p, $text)
}
# Settings' update, pressed: the release check first, then the button's own request.
function Press-Update([string]$What) {
  $v = Need (Send POST /api/settings/version/check) 200 'POST /api/settings/version/check'
  if ($v.latest_release.version -ne $script:Latest) { throw "The release check didn't find $script:Latest." }
  if ($v.self_update.how -ne 'button') { throw "No button on this install: $($v.self_update.how)" }
  $v = Need (Send POST /api/settings/version/update) 202 "POST /api/settings/version/update ($What)"
  if ($v.self_update.run.state -ne 'running') { throw "The update isn't running: $($v.self_update.run.state)" }
  "The update is running: from $($v.self_update.run.from) to $($v.self_update.run.to)"
}
# Until the updater has written its exit code and Cubex answers again, at most 20 minutes.
function Wait-Updater {
  for ($i = 1; $i -le 600; $i++) {
    $code = (Get-Status).code
    if ($null -ne $code) {
      & $Cli status --quiet *> $null
      if ($LASTEXITCODE -eq 0) { "The updater ended after about $($i * 2) s: code $code"; return }
    }
    Start-Sleep -Seconds 2
  }
  "--- cubex status: $(& $Cli status 2>&1)"
  '--- processes'; Get-Process node, powershell -ErrorAction SilentlyContinue | Format-Table Id, ProcessName, StartTime
  throw "The update didn't end within 20 minutes, or Cubex isn't running after it."
}

Step 'The latest release, and the label for the build under test (the release before it)'
$res = Invoke-WebRequest -UseBasicParsing -Method Head -MaximumRedirection 5 `
  "https://github.com/$ReleaseRepo/releases/latest"
$final = if ($res.BaseResponse.ResponseUri) { $res.BaseResponse.ResponseUri.AbsoluteUri } `
  else { $res.BaseResponse.RequestMessage.RequestUri.AbsoluteUri }
if ($final -notmatch '/releases/tag/(v(\d+)\.(\d+)\.(\d+))$') { throw "$ReleaseRepo has no vX.Y.Z release: $final" }
$Latest = $Matches[1]
if ([int]$Matches[4] -eq 0) { throw "The latest release, $Latest, has no patch before it to label this build with." }
$Label = "v$($Matches[2]).$($Matches[3]).$([int]$Matches[4] - 1)"
"Latest release: $Latest. This build is labeled $Label."

Step 'Install the commit under test from its checkout'
& (Join-Path $Src 'install.ps1') --source $Src --port $Port --no-service --no-modify-path
if ($LASTEXITCODE) { throw "install.ps1 exited $LASTEXITCODE." }
Installed

Step "A stand-in for GitHub's releases API that answers $Latest`: a runner's shared address hits its rate limit"
# The release check asks RELEASE_CHECK_URL (an operator setting in config.env), as the e2e harness points it.
$standinPort = [int]$Port + 1
$standinJs = Join-Path $Work 'standin.js'
[IO.File]::WriteAllText($standinJs, @'
const [tag, port] = process.argv.slice(2)
require('http').createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ tag_name: tag, published_at: new Date().toISOString() }))
}).listen(Number(port), '127.0.0.1')
'@)
$standin = Start-Process -FilePath (Join-Path $CubexHome 'node\node.exe') -PassThru -WindowStyle Hidden `
  -ArgumentList "`"$standinJs`"", $Latest, "$standinPort"
[IO.File]::AppendAllText((Join-Path $CubexHome 'config.env'),
  "`r`nRELEASE_CHECK_URL=http://127.0.0.1:$standinPort/latest`r`n")

Step "Label it $Label, following releases, and start it again"
$sha = (& git -C $Src rev-parse --short HEAD).Trim()
[IO.File]::WriteAllText((Join-Path $CubexHome 'app\.cubex-version'), "$Label $sha`r`n")
Set-InstallEnv 'CUBEX_REF' 'stable'
Set-InstallEnv 'CUBEX_SOURCE' ''
& $Cli restart
if ($LASTEXITCODE) { throw "cubex restart exited $LASTEXITCODE." }
Installed

Step 'Choose the password, sign in, and make a sheet that must come through both updates'
Need (Send POST /api/auth/setup @{ password = $Password }) 200 'POST /api/auth/setup' | Out-Null
Sign-In
$made = Need (Send POST /api/settings/access-tokens @{ name = 'update now'; scopes = @('write') }) 201 `
  'POST /api/settings/access-tokens'
"::add-mask::$($made.token)"
$Auth = @{ Authorization = "Bearer $($made.token)" }
$table = Need (Send POST /api/v1/tables @{ name = 'Survives the update' } -Headers $Auth -Session $null) 201 `
  'POST /api/v1/tables'
$SheetId = $table.sheets[0].id
foreach ($name in 'Name', 'City', 'Note') {
  Need (Send POST "/api/v1/sheets/$SheetId/columns" @{ name = $name } -Headers $Auth -Session $null) 201 `
    "POST /api/v1/sheets/$SheetId/columns ($name)" | Out-Null
}
$rows = @(
  @{ data = @{ Name = 'Ada Lovelace'; City = 'London'; Note = 'first row' } },
  @{ data = @{ Name = 'Grace Hopper'; City = 'Arlington'; Note = "commas, `"quotes`" and a`nline break" } },
  @{ data = @{ Name = "Ren$([char]0xE9)e M$([char]0xFC)ller"; City = "Z$([char]0xFC)rich" } }
)
Need (Send POST "/api/v1/sheets/$SheetId/rows" @{ rows = $rows } -Headers $Auth -Session $null) 201 `
  "POST /api/v1/sheets/$SheetId/rows" | Out-Null
$Before = @(Get-SheetLines $SheetId $Auth)
$Before | ForEach-Object { "  $_" }
# An API token can't start one: the route takes a session only.
Need (Send POST /api/settings/version/update -Headers $Auth -Session $null) 401 `
  'POST /api/settings/version/update with the API token' | Out-Null

Step "1. An update whose new version doesn't start: the version before comes back, with the data"
# A copy of the checkout whose server ends as soon as it has loaded, before it answers.
$broken = Join-Path $Work 'broken'
& git clone --quiet --no-hardlinks $Src $broken
& git -C $broken checkout --quiet (& git -C $Src rev-parse HEAD).Trim()
[IO.File]::AppendAllText((Join-Path $broken 'server\src\index.ts'),
  "`n// The must-pass: this build does not start.`nsetImmediate(() => { console.error('This build does not start " +
  "(tests/install/update-now.ps1).'); process.exit(1); });`n")
Set-InstallEnv 'CUBEX_SOURCE' $broken
Press-Update 'to a build that does not start'
Wait-Updater
if ((Get-Status).code -eq 0) { throw 'The update that cannot start ended with code 0.' }
Sign-In
$v = Need (Send GET /api/settings/version) 200 'GET /api/settings/version'
"version $($v.version); the run: $($v.self_update.run.state), code $($v.self_update.run.code)"
if ($v.version -ne $Label) { throw "Not back on $Label`: $($v.version)" }
if ($v.self_update.run.state -ne 'failed') { throw "Settings doesn't say it failed: $($v.self_update.run.state)" }
if ($v.self_update.run.log -notmatch 'the previous one is back') {
  throw "Settings doesn't show what the update said: $($v.self_update.run.log)"
}
Assert-AsBefore
Installed

Step '2. An update that comes through, to a newer build of the commit: Cubex comes back on it with the data'
$newer = Join-Path $Work 'newer'
& git clone --quiet --no-hardlinks $Src $newer
& git -C $newer checkout --quiet (& git -C $Src rev-parse HEAD).Trim()
& git -C $newer -c 'user.name=Update now check' -c user.email=check@example.invalid commit --quiet --allow-empty `
  -m 'A newer build (update-now.ps1)'
$newerSha = (& git -C $newer rev-parse HEAD).Trim()
Set-InstallEnv 'CUBEX_SOURCE' $newer
Sign-In
Press-Update "to the newer build $($newerSha.Substring(0, 7))"
Wait-Updater
if ((Get-Status).code -ne 0) { throw "The update ended with code $((Get-Status).code)." }
# "local <short commit> <date>": the short commit as the installer's git abbreviated it.
$kind, $short = (Get-Content -Raw (Join-Path $CubexHome 'app\.cubex-version')).Trim() -split '\s+'
if ($kind -ne 'local' -or -not $short -or -not $newerSha.StartsWith($short)) { throw "Not on $newerSha`: $(Installed)" }
Assert-AsBefore
Installed
''; 'Update now works here: a failed update rolled back with the data, and the next one came through.'
& $Cli stop
Stop-Process -Id $standin.Id -ErrorAction SilentlyContinue
