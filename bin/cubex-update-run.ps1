# Runs `cubex update` for Settings' "Update now" (server/src/lib/self-update.ts) outside Cubex's own process tree:
# the update stops Cubex first, and `cubex stop` ends Cubex's whole tree (taskkill /t). Copied to the install folder
# before it starts, so the update moving the app folder can't touch it. With -Start it only starts itself: as a
# one-time scheduled task when this user can have tasks, else through this launcher, which exits at once. Then it
# holds update.lock with its pid, writes the update's output to update.log and, once it ends, update-status.json:
# the update's exit code and the versions it went from and to.
param([string]$CubexHome, [string]$From, [string]$To, [switch]$Start)
$ErrorActionPreference = 'Stop'
$self = $MyInvocation.MyCommand.Path
$run = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$self`" -CubexHome `"$CubexHome`" " +
  "-From `"$From`" -To `"$To`""
if ($Start) {
  # A logon task needs a desktop session, as bin/cubex-service.ps1's Test-TaskSupport says.
  $tasks = (Get-Process -Id $PID).SessionId -ne 0 -and
    [bool](Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)
  if ($tasks) {
    $name = "Cubex-update-$([Environment]::UserName -replace '[\\/:*?"<>|]', '_')"
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $run -WorkingDirectory $CubexHome
    Register-ScheduledTask -TaskName $name -TaskPath '\' -Action $action -Force | Out-Null
    Start-ScheduledTask -TaskName $name -TaskPath '\'
  } else {
    Start-Process -FilePath 'powershell.exe' -ArgumentList $run -WorkingDirectory $CubexHome -WindowStyle Hidden
  }
  exit 0
}
Set-Location $CubexHome
Set-Content -Path (Join-Path $CubexHome 'update.lock') -Value $PID -Encoding ascii
$code = 1
try {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $CubexHome 'app\bin\cubex.ps1') update *> `
    (Join-Path $CubexHome 'update.log')
  $code = $LASTEXITCODE
} finally {
  $status = [ordered]@{ code = $code; from = $From; to = $To; ended_at = (Get-Date).ToUniversalTime().ToString('o') }
  $next = Join-Path $CubexHome 'update-status.json.next'
  $status | ConvertTo-Json -Compress | Set-Content -Path $next -Encoding ascii
  Move-Item -Force $next (Join-Path $CubexHome 'update-status.json')
  Remove-Item (Join-Path $CubexHome 'update.lock') -ErrorAction SilentlyContinue
}
