# The copy of the data an update keeps and `cubex rollback`, for bin\cubex.ps1 (which dot-sources this file and
# defines Say, Die, Import-Config, Invoke-Stop, Invoke-Start, Test-ServiceRunning, Test-Healthy, Remove-Tree, $Node,
# $App and $CubexHome). bin/cubex-rollback.sh is the bash twin; the copying itself is bin\cubex-backup.mjs.

# The data files an update copies before the new version can change them. A relative JOBS_DB_PATH is the server's:
# from the app folder.
function Get-DataFiles {
  $db = if ($env:DB_PATH) { $env:DB_PATH } else { Join-Path $CubexHome 'data\cubex.db' }
  $jobs = if ($env:JOBS_DB_PATH) { $env:JOBS_DB_PATH } else { Join-Path (Split-Path $db) 'jobs.db' }
  if (-not [IO.Path]::IsPathRooted($jobs)) { $jobs = Join-Path $App $jobs }
  @($db, $jobs)
}

# For install.ps1: save or restore, never while a server could still write the files. Exits with the script's code.
function Invoke-Backup([string[]]$BackupArgs) {
  Import-Config
  if ((Test-ServiceRunning) -or (Test-Healthy)) { Die 'Cubex is still running. Stop it first: cubex stop' }
  $db, $jobs = Get-DataFiles
  & $Node "$PSScriptRoot\cubex-backup.mjs" $BackupArgs[0] $db $jobs @($BackupArgs | Select-Object -Skip 1) | Out-Null
  exit $LASTEXITCODE
}

# A folder a process that just stopped (or an antivirus scan) still holds a file in refuses a move for a moment.
function Move-Retrying([string]$From, [string]$To) {
  for ($i = 0; ; $i++) {
    try { Move-Item -LiteralPath $From -Destination $To -ErrorAction Stop; return }
    catch { if ($i -ge 40) { throw }; Start-Sleep -Milliseconds 250 }
  }
}

# Puts back the version before the last update and the data as it was then. The apps swap first: if that fails, the
# data is untouched; if putting the data back fails, the apps swap back.
function Invoke-Rollback([string[]]$Rest) {
  Import-Config
  $db, $jobs = Get-DataFiles
  if (-not (Test-Path -LiteralPath "$CubexHome\app.previous")) {
    Die "There's no previous version to go back to: one is kept after an update."
  }
  $info = & $Node "$PSScriptRoot\cubex-backup.mjs" info $db
  if ($LASTEXITCODE -ne 0) { Die "There's no copy of your data from before the last update, so going back isn't safe." }
  $info = $info | ConvertFrom-Json
  $prev = Get-Content -LiteralPath "$CubexHome\app.previous\.cubex-version" -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($info.version -ne $prev) {
    Die ("The data kept before the last update is from Cubex $($info.version), but the previous version is $prev. " +
      "Going back isn't safe.")
  }
  # The previous version's native modules were built for the Node it was installed with.
  $nodeMajor = (& $Node -p 'process.versions.node.split(".")[0]')
  $builtFor = Get-Content -LiteralPath "$CubexHome\app.previous\.cubex-node" -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $builtFor) { $builtFor = '22' }
  if ($builtFor.Trim() -ne $nodeMajor.Trim()) {
    Die ("Cubex $prev was built for Node $builtFor, and Node $nodeMajor is installed now. " +
      'Install that version again instead.')
  }
  Say "This puts back Cubex $prev and your data as it was at $($info.at), before the update. Everything changed since"
  Say 'then goes: rows, runs and settings, and sign-in too (a password changed or a token revoked since comes back).'
  Say "The data from now is kept in $(Split-Path $db)\backups."
  if ($Rest -notcontains '--yes') {
    if ((Read-Host 'Type rollback to confirm') -ne 'rollback') { Die 'Nothing was changed.' }
  }
  $lock = "$CubexHome\.install-lock"
  try { New-Item -ItemType Directory -Path $lock -ErrorAction Stop | Out-Null }
  catch { Die "An install or update is running. If not, delete $lock and try again." }
  try {
    $wasRunning = Test-ServiceRunning
    $q = $Quiet; $Quiet = $true; Invoke-Stop; $Quiet = $q
    if ((Test-ServiceRunning) -or (Test-Healthy)) {
      Die 'Cubex is still running, so nothing was changed. Try cubex stop.'
    }
    Remove-Tree "$CubexHome\app.failed"
    try { Move-Retrying "$CubexHome\app" "$CubexHome\app.failed" }
    catch { Die "Couldn't move the current version aside. Nothing was changed." }
    try { Move-Retrying "$CubexHome\app.previous" "$CubexHome\app" }
    catch {
      Move-Retrying "$CubexHome\app.failed" "$CubexHome\app"
      Die "Couldn't put the previous version in place. Nothing was changed."
    }
    # This script's own folder moved to app.failed with the newer version.
    & $Node "$CubexHome\app.failed\bin\cubex-backup.mjs" restore $db $jobs | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Move-Retrying "$CubexHome\app" "$CubexHome\app.previous"
      Move-Retrying "$CubexHome\app.failed" "$CubexHome\app"
      if ($wasRunning) { try { Invoke-Start } catch { } }
      Die ('Putting your data back stopped (see above); the newer version is in place again. ' +
        'Run cubex rollback to retry.')
    }
  } finally { Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue }
  Say "Cubex $prev is back, with your data from before the update. The newer version is in $CubexHome\app.failed."
  # This (newer) script's start, which waits for a big database; the service runs what's in app now.
  if ($wasRunning) { Invoke-Start }
}
