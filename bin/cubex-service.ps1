# Keeping Cubex running on Windows, dot-sourced by bin/cubex.ps1: a scheduled task that starts it when you log in
# (no administrator rights needed), or else a plain background process (which doesn't come back after a restart).
# CUBEX_SERVICE in config.env overrides the choice: task or none. Every function here runs after Import-Config.
#
# Both start `cubex.ps1 run` inside `conhost.exe --headless`, so no console window ever shows. Windows has no way to
# ask a windowless process to shut down cleanly, so stopping ends the runner and the server at once, like a power
# cut: the databases keep everything already saved.

$TaskNote = 'Starts Cubex when you log in. Written by install.ps1; manage it with the cubex command.'
$Conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
$PowerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

# Read after config.env, where CUBEX_SERVICE_TASK can rename the task (one Cubex per user gets the default).
function Get-TaskName { if ($env:CUBEX_SERVICE_TASK) { $env:CUBEX_SERVICE_TASK } else { 'Cubex' } }

# A logon task needs a desktop session: a service or a CI runner in session 0 gets the plain process.
function Test-TaskSupport {
  (Get-Process -Id $PID).SessionId -ne 0 -and [bool](Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)
}

function Get-ServiceMode {
  if ($env:CUBEX_SERVICE -and $env:CUBEX_SERVICE -ne 'auto') { return $env:CUBEX_SERVICE }
  if (Test-TaskSupport) { 'task' } else { 'none' }
}

function Get-ServiceDescription {
  if ((Get-ServiceMode) -eq 'task') { return "a scheduled task ($(Get-TaskName)), so it starts when you log in" }
  'a background process; run cubex start again after a restart'
}

# This install's runners: Windows PowerShell running <app>\bin\cubex.ps1 run. Found by their command line, which
# conhost rebuilds (quoting only what needs it), so no PID file can go stale.
function Get-RunnerIds {
  $script = "$App\bin\cubex.ps1"
  @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -and $_.CommandLine.IndexOf($script, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      $_.CommandLine.TrimEnd() -match ' run$'
  } | ForEach-Object { $_.ProcessId })
}

function Test-ServiceRunning { [bool](Get-RunnerIds) }

function Get-RunnerArguments {
  "--headless `"$PowerShellExe`" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass " +
    "-File `"$App\bin\cubex.ps1`" run"
}

function Start-CubexService {
  Stop-Runner # one copy only
  if ((Get-ServiceMode) -eq 'task') { Start-CubexTask; return }
  Start-Process -FilePath $Conhost -ArgumentList (Get-RunnerArguments) -WorkingDirectory $CubexHome -WindowStyle Hidden
}

function Stop-CubexService {
  # Disabled, not deleted: like launchd and systemd here, a stopped Cubex stays stopped at the next login.
  $task = Get-CubexTask
  if ($task) { $task | Disable-ScheduledTask | Out-Null }
  Stop-Runner
  if ($task) { $task | Stop-ScheduledTask -ErrorAction SilentlyContinue }
}

function Remove-CubexService {
  Stop-CubexService
  $task = Get-CubexTask
  if ($task) { $task | Unregister-ScheduledTask -Confirm:$false }
}

# The task by that name, if install.ps1 made it. A task with the same name that isn't Cubex's is never touched.
function Get-CubexTask {
  if (-not (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue)) { return $null }
  $task = Get-ScheduledTask -TaskName (Get-TaskName) -TaskPath '\' -ErrorAction SilentlyContinue
  if ($task -and $task.Description -eq $TaskNote) { return $task }
  $null
}

function Start-CubexTask {
  $name = Get-TaskName
  if (-not (Get-CubexTask) -and (Get-ScheduledTask -TaskName $name -TaskPath '\' -ErrorAction SilentlyContinue)) {
    Die ("A scheduled task named $name already exists and isn't Cubex's. Set CUBEX_SERVICE_TASK in $Config to " +
      'another name.')
  }
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $action = New-ScheduledTaskAction -Execute $Conhost -Argument (Get-RunnerArguments) -WorkingDirectory $CubexHome
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $me
  $trigger.Delay = 'PT30S' # after the desktop has settled
  $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
  # No 3-day time limit, keeps running on battery, one copy, normal priority (the default 7 is below normal).
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -Priority 5
  try {
    # -Force replaces the whole definition, so nothing from an older one lingers.
    Register-ScheduledTask -TaskName $name -TaskPath '\' -Description $TaskNote -Action $action -Trigger $trigger `
      -Principal $principal -Settings $settings -Force | Out-Null
    Start-ScheduledTask -TaskName $name -TaskPath '\'
  } catch {
    Die ("Windows didn't accept the scheduled task ($($_.Exception.Message.Trim())). To run Cubex without one, " +
      "add CUBEX_SERVICE=none to $Config.")
  }
}

# Ends the runner, the server and anything else still running this install's Node on server\dist\index.js (a
# server whose runner was killed some other way, say). Taskkill /T takes each one's child processes with it.
function Stop-Runner {
  $ids = @(Get-RunnerIds) + @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -eq $Node -and $_.CommandLine -like '*server\dist\index.js*' } |
    ForEach-Object { $_.ProcessId })
  foreach ($id in $ids) { [void](Invoke-Cmd "taskkill /pid $id /t /f >nul 2>&1") }
  foreach ($id in $ids) { # gone, so its files can be replaced
    for ($i = 0; $i -lt 40 -and (Get-Process -Id $id -ErrorAction Ignore); $i++) { Start-Sleep -Milliseconds 250 }
  }
}
