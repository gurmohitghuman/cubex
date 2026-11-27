# Runs `cubex update` for Settings' "Update now" (server/src/lib/self-update.ts) outside Cubex's own process tree:
# the update stops Cubex first, and `cubex stop` ends Cubex's whole tree (taskkill /t). Copied to the install folder
# before it starts, so the update moving the app folder can't touch it. With -Start it only starts itself: as a
# one-time scheduled task when this user can have tasks, else through this launcher, which exits at once. Then it
# holds update.lock with its pid, writes the update's output to update.log and, once it ends, update-status.json:
# the update's exit code, the versions it went from and to, and its last lines then (log).
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
$log = Join-Path $CubexHome 'update.log'
$code = 1
$tail = ''
try {
  # The update's output goes straight into update.log through cmd's redirect, as UTF-8 (code page 65001), each line
  # as it comes so the page can show it. Not a PowerShell pipe: Cubex, started by the update, keeps the update's
  # output handle, and a pipe was cut short when the update ended, losing the installer's last lines (its error);
  # *> also writes UTF-16. Paths go in as %NAME%, which cmd expands once (a % in a folder name stays text).
  $env:CUBEX_UPDATE_CLI = Join-Path $CubexHome 'app\bin\cubex.ps1'
  $env:CUBEX_UPDATE_LOG = $log
  $psi = New-Object Diagnostics.ProcessStartInfo (Join-Path $env:SystemRoot 'System32\cmd.exe'), ('/d /v:off /s /c ' +
    '"chcp 65001 >nul & powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%CUBEX_UPDATE_CLI%" update ' +
    '>"%CUBEX_UPDATE_LOG%" 2>&1"')
  $psi.UseShellExecute = $false
  $psi.WorkingDirectory = $CubexHome
  $p = [Diagnostics.Process]::Start($psi)
  $p.WaitForExit()
  $code = $p.ExitCode
  # Its last lines as the update ended: Cubex, started by it, may go on writing to update.log.
  $tail = (Get-Content -LiteralPath $log -Tail 40 -Encoding UTF8 -ErrorAction SilentlyContinue) -join "`n"
} finally {
  $status = [ordered]@{ code = $code; from = $From; to = $To; ended_at = (Get-Date).ToUniversalTime().ToString('o')
    log = $tail }
  $next = Join-Path $CubexHome 'update-status.json.next'
  $status | ConvertTo-Json -Compress | Set-Content -Path $next -Encoding ascii
  Move-Item -Force $next (Join-Path $CubexHome 'update-status.json')
  Remove-Item (Join-Path $CubexHome 'update.lock') -ErrorAction SilentlyContinue
}
