# Keeping Cubex running on Windows, dot-sourced by bin/cubex.ps1: a scheduled task that starts it when you log in
# (no administrator rights needed), or else a plain background process (which doesn't come back after a restart).
# CUBEX_SERVICE in config.env overrides the choice: task or none. Every function here runs after Import-Config.
#
# Both run the private Node on bin\cubex-run.mjs, which keeps the server running and writes its log; no PowerShell
# stays in the background. The task hosts it in `conhost.exe --headless` and the plain process starts hidden, so no
# console window ever shows. Windows has no way to ask a windowless process to shut down cleanly, so stopping ends
# the runner and the server at once, like a power cut: the databases keep everything already saved.

$TaskNote = 'Starts Cubex when you log in. Written by install.ps1; manage it with the cubex command.'
$Conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
$Runner = Join-Path $App 'bin\cubex-run.mjs'

# Read after config.env, where CUBEX_SERVICE_TASK can rename the task. Task names are machine-wide, so the default
# carries the user name: each user of this PC can have a Cubex of their own.
function Get-TaskName {
  if ($env:CUBEX_SERVICE_TASK) { return $env:CUBEX_SERVICE_TASK }
  $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name.Split('\')[-1]
  "Cubex-$($user -replace '[\\/:*?"<>|]', '_')"
}

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

# Elevated ("Run as administrator") while this user also has a normal, limited token: a server started from here
# would run elevated, and a normal window couldn't see or stop it. Off when UAC is, and for the built-in Administrator
# without Admin Approval Mode: there every window is elevated alike.
function Test-SplitElevated {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $admin = [Security.Principal.WindowsBuiltInRole]::Administrator
  if (-not (New-Object Security.Principal.WindowsPrincipal $id).IsInRole($admin)) { return $false }
  $uac = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -ErrorAction Ignore
  if ($uac -and $uac.EnableLUA -eq 0) { return $false }
  -not ($id.User.Value -match '-500$' -and -not ($uac -and $uac.FilterAdministratorToken -eq 1))
}

# This install's runners: its Node running <app>\bin\cubex-run.mjs. Found by their command line (which the task's
# conhost rebuilds, quoting only what needs it), so no PID file can go stale.
function Get-RunnerIds {
  @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -and $_.CommandLine.IndexOf($Runner, [StringComparison]::OrdinalIgnoreCase) -ge 0
  } | ForEach-Object { $_.ProcessId })
}

function Test-ServiceRunning { [bool](Get-RunnerIds) }

function Start-CubexService {
  $task = (Get-ServiceMode) -eq 'task'
  if (-not $task -and $env:CUBEX_ALLOW_ELEVATED -ne '1' -and (Test-SplitElevated)) {
    Die ('This window runs as administrator, so Cubex would too, and a normal window couldn''t stop it. Run ' +
      'cubex start in a normal PowerShell window (or set CUBEX_ALLOW_ELEVATED=1 to start it elevated anyway).')
  }
  Stop-Runner # one copy only
  if ($task) { Start-CubexTask; return }
  Start-Process -FilePath $Node -ArgumentList "`"$Runner`"" -WorkingDirectory $CubexHome -WindowStyle Hidden
}

function Stop-CubexService {
  Remove-LegacyTask
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

# Earlier builds named the task \Cubex for everyone. That one goes when it's Cubex's and starts this install.
function Remove-LegacyTask {
  if ($env:CUBEX_SERVICE_TASK -or -not (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue)) { return }
  $task = Get-ScheduledTask -TaskName 'Cubex' -TaskPath '\' -ErrorAction SilentlyContinue
  if (-not $task -or $task.Description -ne $TaskNote) { return }
  $mine = "$App\bin\"
  $any = [StringComparison]::OrdinalIgnoreCase
  if (-not @($task.Actions | Where-Object { "$($_.Arguments)".IndexOf($mine, $any) -ge 0 })) { return }
  $task | Stop-ScheduledTask -ErrorAction SilentlyContinue
  $task | Unregister-ScheduledTask -Confirm:$false
}

function Start-CubexTask {
  $name = Get-TaskName
  if (-not (Get-CubexTask) -and (Get-ScheduledTask -TaskName $name -TaskPath '\' -ErrorAction SilentlyContinue)) {
    Die ("A scheduled task named $name already exists and isn't Cubex's. Set CUBEX_SERVICE_TASK in $Config to " +
      'another name.')
  }
  Remove-LegacyTask
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $arguments = "--headless `"$Node`" `"$Runner`""
  $action = New-ScheduledTaskAction -Execute $Conhost -Argument $arguments -WorkingDirectory $CubexHome
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $me
  $trigger.Delay = 'PT30S' # after the desktop has settled
  # Limited, even when installed from an elevated window, so a normal window can always stop it.
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
    Die ("Windows didn't accept the scheduled task $name ($($_.Exception.Message.Trim())). Set CUBEX_SERVICE_TASK " +
      "in $Config to another name, or add CUBEX_SERVICE=none there to run Cubex without a task.")
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
