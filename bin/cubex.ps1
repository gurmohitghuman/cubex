# The `cubex` command on Windows, for a Cubex installed with install.ps1. Run `cubex help`.
# The cubex.cmd launcher install.ps1 puts on PATH runs it with Windows PowerShell, whatever the execution policy
# (unless Group Policy sets one, which install.ps1 checks for).
#
# Over 200 lines: bin/cubex's twin, command for command, so the two are easy to compare.
$ErrorActionPreference = 'Stop'

# The launcher passes CUBEX_HOME; without it, the Cubex folder is two up from this file (<home>\app\bin).
$CubexHome = [IO.Path]::GetFullPath($(if ($env:CUBEX_HOME) { $env:CUBEX_HOME } else { "$PSScriptRoot\..\.." }))
$env:CUBEX_HOME = $CubexHome
$App = Join-Path $CubexHome 'app'
$Node = Join-Path $CubexHome 'node\node.exe'
$Config = Join-Path $CubexHome 'config.env'
$Log = Join-Path $CubexHome 'logs\cubex.log'
$Cmd = Join-Path $env:SystemRoot 'System32\cmd.exe'
$Quiet = $false
. (Join-Path $PSScriptRoot 'cubex-service.ps1')
. (Join-Path $PSScriptRoot 'cubex-rollback.ps1')

function Say([string]$Text) { if (-not $Quiet) { Write-Output $Text } }
function Die([string]$Text) { [Console]::Error.WriteLine("Error: $Text"); exit 1 }

# Runs a cmd.exe line exactly as written (PowerShell's own quoting of native arguments differs between versions), in
# $In: a started process gets Windows' working folder, which Set-Location doesn't change. Paths go in as $Vars, read
# in the line as %NAME%: cmd expands those once, so a % in a folder name stays text.
function Invoke-Cmd([string]$Line, [string]$In = $env:SystemRoot, [hashtable]$Vars = @{}) {
  $psi = New-Object Diagnostics.ProcessStartInfo $Cmd, "/d /v:off /s /c `"$Line`""
  $psi.WorkingDirectory = $In
  $psi.UseShellExecute = $false
  $saved = @{}
  foreach ($name in $Vars.Keys) {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name)
    [Environment]::SetEnvironmentVariable($name, $Vars[$name])
  }
  try {
    $p = [Diagnostics.Process]::Start($psi)
    $p.WaitForExit()
  } finally { foreach ($name in $Vars.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name]) } }
  $p.ExitCode
}

# rd, not Remove-Item: Windows PowerShell's Remove-Item -Recurse follows folder links into their targets. A file the
# server just let go of can stay locked for a moment, so it tries again for up to 10 s.
function Remove-Tree([string]$Path) {
  for ($i = 0; $i -lt 20 -and (Test-Path -LiteralPath $Path); $i++) {
    if ($i) { Start-Sleep -Milliseconds 500 }
    if (Test-Path -LiteralPath $Path -PathType Leaf) { Remove-Item -LiteralPath $Path -Force -ErrorAction Ignore }
    else { [void](Invoke-Cmd 'rd /s /q "%CUBEX_RD%" >nul 2>&1' -Vars @{ CUBEX_RD = $Path }) }
  }
  if (Test-Path -LiteralPath $Path) { Die "Couldn't delete $Path, a program still has a file in it open." }
}

# A KEY=value file into a hashtable: blank lines and # comments skipped, matching quotes stripped, nothing executed.
function Read-KeyValues([string]$Path) {
  $values = [ordered]@{}
  if (-not (Test-Path -LiteralPath $Path)) { return $values }
  foreach ($raw in [IO.File]::ReadAllLines($Path)) {
    $line = $raw.TrimStart()
    if ($line -eq '' -or $line.StartsWith('#') -or -not $line.Contains('=')) { continue }
    $key, $val = $line.Split('=', 2)
    if ($key -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { continue }
    if ($val.Length -ge 2 -and $val[0] -eq $val[-1] -and '"', "'" -contains $val[0]) {
      $val = $val.Substring(1, $val.Length - 2)
    }
    $values[$key] = $val
  }
  $values
}

# config.env into the environment.
function Import-Config {
  $values = Read-KeyValues $Config
  foreach ($key in $values.Keys) { [Environment]::SetEnvironmentVariable($key, $values[$key], 'Process') }
  if (-not $env:PORT) { $env:PORT = '3002' }
  if (-not $env:HOST) { $env:HOST = '127.0.0.1' }
  $port = $env:PORT -as [int]
  if ($env:PORT -notmatch '^[0-9]+$' -or $port -lt 1 -or $port -gt 65535) {
    Die "PORT in $Config must be a number from 1 to 65535."
  }
  # A relative DB_PATH means inside the Cubex folder, never inside the app folder an update replaces.
  if ($env:DB_PATH -and -not [IO.Path]::IsPathRooted($env:DB_PATH)) { $env:DB_PATH = Join-Path $CubexHome $env:DB_PATH }
}

function Get-ProbeUrl { # how this machine reaches Cubex
  if ('0.0.0.0', '::', '127.0.0.1', 'localhost' -contains $env:HOST) { return "http://127.0.0.1:$env:PORT" }
  if ($env:HOST.Contains(':')) { return "http://[$($env:HOST)]:$env:PORT" }
  "http://$($env:HOST):$env:PORT"
}
function Get-DisplayUrl {
  if ('0.0.0.0', '::', '127.0.0.1', 'localhost' -contains $env:HOST) { return "http://localhost:$env:PORT" }
  Get-ProbeUrl
}
function Test-Healthy {
  $res = $null
  try {
    # Straight to the server, never through a proxy set up for the internet.
    $req = [Net.HttpWebRequest]::Create("$(Get-ProbeUrl)/api/health")
    $req.Proxy = $null; $req.Timeout = 2000; $req.ReadWriteTimeout = 2000; $req.KeepAlive = $false
    $res = $req.GetResponse()
    (New-Object IO.StreamReader $res.GetResponseStream()).ReadToEnd().Contains('"status":"ok"')
  } catch [Net.WebException] {
    # A 503 while it starts up is a response too: unclosed, it holds one of the 2 connections .NET allows per
    # server, and after two of them every later check waits out its timeout.
    $res = $_.Exception.Response
    $false
  } catch { $false } finally { if ($res) { $res.Close() } }
}
function Test-PortInUse { # anything answering on the port, Cubex or not
  $uri = [Uri](Get-ProbeUrl)
  $client = New-Object Net.Sockets.TcpClient
  try { $client.ConnectAsync($uri.DnsSafeHost, $uri.Port).Wait(2000) } catch { $false } finally { $client.Close() }
}
function Test-Running { (Test-ServiceRunning) -and (Test-Healthy) }

# What the service starts, here in the foreground: bin\cubex-run.mjs runs the server, appends its output to the log
# (rotated past 10 MB) and starts it again after a crash, waiting longer each time.
function Invoke-Run {
  Import-Config
  & $Node $Runner
  exit $LASTEXITCODE
}

# The restarts bin\cubex-run.mjs logged after byte $From of the log (all of it, when the log was rotated meanwhile).
function Get-Restarts([long]$From) {
  if (-not (Test-Path -LiteralPath $Log)) { return 0 }
  $file = [IO.File]::Open($Log, 'Open', 'Read', 'ReadWrite')
  try {
    if ($file.Length -lt $From) { $From = 0 }
    [void]$file.Seek($From, 'Begin')
    $text = (New-Object IO.StreamReader($file)).ReadToEnd()
  } finally { $file.Dispose() }
  ([regex]::Matches($text, 'Cubex stopped \(')).Count
}

# How long a start may take (CUBEX_START_TIMEOUT seconds, 30 to 86400): a big database is checked, and upgraded by
# a new version's migrations, before Cubex answers. A runner that stopped, or that had to start the server again
# twice (it keeps crashing: bin\cubex-run.mjs logs each restart), fails at once.
function Invoke-Start {
  Import-Config
  $timeout = 600
  if ($env:CUBEX_START_TIMEOUT -match '^\d{1,8}$') {
    $timeout = [Math]::Min(86400, [Math]::Max(30, [int]$env:CUBEX_START_TIMEOUT))
  }
  if (Test-Running) { Say "Cubex is already running: $(Get-DisplayUrl)"; return }
  $serviceRunning = Test-ServiceRunning
  if (-not $serviceRunning -and (Test-PortInUse)) {
    Die "Port $env:PORT is in use by another program. Set another PORT in $Config, then run: cubex start"
  }
  New-Item -ItemType Directory -Force -Path (Split-Path $Log) | Out-Null
  $logFrom = if (Test-Path -LiteralPath $Log) { (Get-Item -LiteralPath $Log).Length } else { 0 }
  Start-CubexService
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $said = $false
  while (-not (Test-Healthy)) {
    $seconds = $clock.Elapsed.TotalSeconds
    $gone = $seconds -ge 10 -and -not (Test-ServiceRunning)
    if ($seconds -ge $timeout -or $gone -or (Get-Restarts $logFrom) -ge 2) {
      Stop-CubexService
      if (Test-Path -LiteralPath $Log) { Get-Content -LiteralPath $Log -Tail 20 -Encoding UTF8 | Out-Host }
      if ($seconds -ge $timeout) {
        Die "Cubex didn't answer within $timeout seconds (CUBEX_START_TIMEOUT in $Config). Log: $Log"
      }
      Die "Cubex didn't start; the end of its log is above. Full log: $Log"
    }
    if (-not $said -and $seconds -ge 20) {
      # Shown with --quiet too: an installer waiting minutes should say why.
      Write-Host '  Still starting: a big database takes a while to check (and to upgrade, after an update).'
      $said = $true
    }
    Start-Sleep -Milliseconds 500
  }
  Say "Cubex is running: $(Get-DisplayUrl)"
}

function Invoke-Stop {
  Import-Config
  Stop-CubexService
  Say 'Cubex stopped.'
}

function Invoke-Status {
  Import-Config
  if (Test-Running) {
    if ($Quiet) { exit 0 }
    Say "Cubex is running: $(Get-DisplayUrl)"
  } else {
    if ($Quiet) { exit 1 }
    if (Test-ServiceRunning) { Say 'Cubex is starting, or failing to start (see: cubex logs).' }
    elseif (Test-PortInUse) { Say "Cubex is stopped, and another program is using port $env:PORT." }
    else { Say 'Cubex is stopped. Start it with: cubex start' }
  }
  $version = 'unknown'
  $versionFile = "$App\.cubex-version"
  if (Test-Path -LiteralPath $versionFile) { $version = Get-Content -LiteralPath $versionFile -TotalCount 1 }
  Say "  Version:  $version, Node $(& $Node --version)"
  Say "  Runs as:  $(Get-ServiceDescription)"
  Say "  Data:     $(Split-Path $(if ($env:DB_PATH) { $env:DB_PATH } else { "$CubexHome\data\cubex.db" }))"
  Say "  Settings: $Config"
  Say "  Log:      $Log"
}

# An update is the installer run again: it keeps data and settings, rebuilds, and puts the previous version back if
# the new one doesn't start.
function Invoke-Update([string[]]$Rest) {
  $install = Read-KeyValues "$CubexHome\install.env"
  foreach ($key in 'CUBEX_REPO', 'CUBEX_REF', 'CUBEX_BIN_DIR') {
    if ($install[$key]) { [Environment]::SetEnvironmentVariable($key, $install[$key], 'Process') }
  }
  $ps = Join-Path $PSHOME 'powershell.exe'
  # Older Windows PowerShell may offer only TLS 1.0, which GitHub refuses (the installer does the same).
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072
  $source = $install['CUBEX_SOURCE']
  if ($source) {
    & $ps -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$source\install.ps1" --source $source @Rest
    exit $LASTEXITCODE
  }
  $repo = $env:CUBEX_REPO
  $ref = if ($env:CUBEX_REF) { $env:CUBEX_REF } else { 'stable' }
  if ($ref -eq 'stable') { $ref = Get-LatestRef $repo } # the installer of the latest release (main until there is one)
  $script = Join-Path ([IO.Path]::GetTempPath()) "cubex-install-$PID.ps1"
  try {
    $web = New-Object Net.WebClient
    $web.Headers['User-Agent'] = 'cubex'
    $web.DownloadFile("https://raw.githubusercontent.com/$repo/$ref/install.ps1", $script)
  } catch { Die "Couldn't download the installer. Check your internet connection." }
  try { & $ps -NoLogo -NoProfile -ExecutionPolicy Bypass -File $script @Rest; $code = $LASTEXITCODE }
  finally { Remove-Item -LiteralPath $script -Force -ErrorAction SilentlyContinue }
  exit $code
}

function Get-LatestRef([string]$Repo) {
  try {
    $req = [Net.HttpWebRequest]::Create("https://github.com/$Repo/releases/latest")
    $req.Method = 'HEAD'; $req.AllowAutoRedirect = $false; $req.UserAgent = 'cubex'
    $res = $req.GetResponse()
    try { $location = $res.Headers['Location'] } finally { $res.Close() }
  } catch { Die "Couldn't reach GitHub. Check your internet connection." }
  if ($location -match '/releases/tag/([^/?#]+)$') { return $Matches[1] }
  'main'
}

function Invoke-ResetPassword {
  Import-Config
  if (-not $env:DB_PATH) { $env:DB_PATH = Join-Path $CubexHome 'data\cubex.db' }
  Set-Location -LiteralPath $App
  & $Node server\dist\cli\reset-password.js
  exit $LASTEXITCODE
}

# Removes only Cubex's own entries, by name. The folder itself goes only with --delete-data, and only if nothing
# else is left in it. The folders go first and the cubex command last, so if a folder can't be deleted (a program
# still has a file in it open), cubex uninstall is still there to run again.
function Invoke-Uninstall([string[]]$Rest) {
  $purge = $Rest -contains '--delete-data'
  $notAlone = @($env:SystemDrive, $env:SystemRoot, $env:USERPROFILE, $env:LOCALAPPDATA, $env:APPDATA) |
    ForEach-Object { "$_".TrimEnd('\') }
  if ($notAlone -contains $CubexHome.TrimEnd('\')) { Die "Refusing to remove $CubexHome." }
  if (-not (Test-Path -LiteralPath "$CubexHome\.cubex-home")) { Die "$CubexHome doesn't look like a Cubex install." }
  $ownBin = Join-Path $CubexHome 'bin'
  $install = Read-KeyValues "$CubexHome\install.env"
  $binDir = $install['CUBEX_BIN_DIR']
  if (-not $binDir) { $binDir = $ownBin }
  # The PATH entries the installer added, exactly. Before install.env kept that list, only its own bin was added.
  $added = if ($install.Contains('CUBEX_PATH_ADDED')) { $install['CUBEX_PATH_ADDED'] }
  elseif ($binDir.TrimEnd('\') -eq $ownBin) { $ownBin } else { '' }
  if ($purge) {
    Write-Output "This permanently deletes every table, sheet and setting in $CubexHome."
    if ((Read-Host 'Type delete to confirm') -ne 'delete') { Die 'Nothing was removed.' }
  }
  Import-Config
  Remove-CubexService
  Set-Location -LiteralPath $env:SystemRoot # out of the folders about to go
  $entries = 'app', 'app.next', 'app.previous', 'app.failed', 'node', 'node.next', 'node.previous', 'node.failed',
    'logs', '.install-lock'
  if ($purge) { $entries += 'data', 'config.env' }
  foreach ($entry in $entries) { Remove-Tree (Join-Path $CubexHome $entry) }
  Remove-Tree "$CubexHome\install.env" # what uninstall needs to run again, so after the folders
  $shim = Join-Path $binDir 'cubex.cmd'
  if ((Test-Path -LiteralPath $shim) -and (Select-String -LiteralPath $shim -SimpleMatch 'Cubex launcher' -Quiet)) {
    Remove-Item -LiteralPath $shim -Force
  }
  # The folder only when it's Cubex's own and empty: a CUBEX_BIN_DIR of yours may have been there before.
  if ($binDir.TrimEnd('\') -eq $ownBin -and (Test-Path -LiteralPath $binDir) -and
    -not (Get-ChildItem -LiteralPath $binDir -Force)) {
    Remove-Item -LiteralPath $binDir -Force
  }
  foreach ($dir in $added.Split(';')) { if ($dir) { Remove-UserPath $dir } }
  if (-not $purge) {
    Say "Cubex is uninstalled. Your data and settings are still in $CubexHome; delete that folder to remove them too."
    return
  }
  Remove-Tree (Join-Path $CubexHome '.cubex-home')
  if (-not (Get-ChildItem -LiteralPath $CubexHome -Force)) {
    Remove-Item -LiteralPath $CubexHome -Force
    Say 'Cubex and all its data are removed.'
  } else {
    Say "Cubex and its data are removed. $CubexHome had other files in it, so it was left in place."
  }
}

# The launcher's folder off the user PATH, keeping the other entries and the value's type as they are.
function Remove-UserPath([string]$Dir) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  try {
    $old = $key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
    if (-not $old) { return }
    $entries = $old.Split(';')
    $kept = @($entries | Where-Object { -not $_ -or $_.TrimEnd('\') -ne $Dir.TrimEnd('\') })
    if ($kept.Count -eq $entries.Count) { return }
    $key.SetValue('Path', ($kept -join ';'), $key.GetValueKind('Path'))
  } finally { $key.Close() }
  # Removing a variable that isn't there tells open programs the environment changed, and changes nothing else.
  [Environment]::SetEnvironmentVariable('CUBEX_PATH_CHANGED', $null, 'User')
}

function Show-Usage {
  @'
Usage: cubex <command>

  start            Start Cubex in the background
  stop             Stop it
  restart          Restart it (after changing settings)
  status           Is it running, where, which version
  open             Open Cubex in your browser
  logs             Follow the server log (Ctrl+C to stop)
  update           Update to the latest release (data and settings are kept)
  rollback         Go back to the version and the data from before the last update (--yes: don't ask)
  config           Show the settings file
  reset-password   Choose a new password (signs out every browser)
  uninstall        Remove Cubex but keep your data (--delete-data removes it too)
'@
}

$command = if ($args.Count) { [string]$args[0] } else { 'help' }
$rest = @($args | Select-Object -Skip 1 | ForEach-Object { [string]$_ })
if ($rest.Count -and $rest[0] -eq '--quiet') { $Quiet = $true; $rest = @($rest | Select-Object -Skip 1) }
if ('help', '-h', '--help', 'uninstall' -notcontains $command -and -not (Test-Path -LiteralPath $App)) {
  Die "Cubex isn't installed in $CubexHome."
}
switch ($command) {
  'run' { Invoke-Run }
  'start' { Invoke-Start }
  'stop' { Invoke-Stop }
  'restart' { $q = $Quiet; $Quiet = $true; Invoke-Stop; $Quiet = $q; Invoke-Start }
  'status' { Invoke-Status }
  'is-active' { Import-Config; if (Test-ServiceRunning) { exit 0 } else { exit 1 } } # for install.ps1
  'open' { Import-Config; Start-Process (Get-DisplayUrl) }
  'url' { Import-Config; Get-DisplayUrl }
  'logs' {
    if (-not (Test-Path -LiteralPath $Log)) { Die "There's no log yet." }
    Get-Content -LiteralPath $Log -Tail 100 -Wait -Encoding UTF8
  }
  'update' { Invoke-Update $rest }
  'rollback' { Invoke-Rollback $rest }
  # For install.ps1: keep a copy of the data before an update / put it back.
  'snapshot' { Invoke-Backup (@('save') + $rest) }
  'restore-snapshot' { Invoke-Backup @('restore') }
  'config' {
    Write-Output "Settings file: $Config (after a change, run: cubex restart)"
    ''
    Get-Content -LiteralPath $Config
  }
  'reset-password' { Invoke-ResetPassword }
  'uninstall' { Invoke-Uninstall $rest }
  { 'version', '--version' -contains $_ } { Get-Content -LiteralPath "$App\.cubex-version"; & $Node --version }
  { 'help', '-h', '--help' -contains $_ } { Show-Usage }
  default { [Console]::Error.WriteLine((Show-Usage)); Die "Unknown command: $command" }
}
