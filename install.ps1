# Install or update Cubex on Windows with one command, no Docker, no WSL, no administrator rights. In PowerShell:
#
#   irm https://raw.githubusercontent.com/gurmohitghuman/cubex/main/install.ps1 | iex
#
# Options (listed by --help) go after the script, run as a script block:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/gurmohitghuman/cubex/main/install.ps1))) --public
#
# Everything lives in %LOCALAPPDATA%\cubex: a private Node.js (Cubex never uses or changes yours), the app, your data
# and config.env. The only thing added elsewhere is that folder's bin, holding just the cubex command, on your user
# PATH. Running it again updates Cubex and keeps your data and settings. On macOS and Linux, use install.sh.
#
# Over 200 lines: one file that runs on its own before anything else is downloaded; install.sh's twin, step by step.

& { # one block, so nothing it defines stays behind in the window that ran it
# First, before anything a locked-down PowerShell (AppLocker or WDAC) can't run.
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
  Write-Host ("Error: PowerShell is locked down on this PC ($($ExecutionContext.SessionState.LanguageMode)), so " +
    'neither this installer nor the cubex command can run. Ask whoever manages this PC, or use WSL2 or Docker.')
  if ({}.File) { exit 1 } # run as a file (cubex update); pasted text keeps the window open
  $global:LASTEXITCODE = 1
  return
}
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # the progress bar makes downloads many times slower
$RunAsFile = [bool]{}.File # pasted text (irm | iex) has no file, and there `exit` would close the window
$Repo = if ($env:CUBEX_REPO) { $env:CUBEX_REPO } else { 'gurmohitghuman/cubex' } # the public GitHub repository
$Ref = if ($env:CUBEX_REF) { $env:CUBEX_REF } else { 'stable' } # stable = the latest release
$CubexHome = if ($env:CUBEX_HOME) { $env:CUBEX_HOME } else { Join-Path $env:LOCALAPPDATA 'cubex' }
$NodeMajor = 22
$Marker = '.cubex-home' # marks a folder as a Cubex install; uninstall only ever deletes inside those
$Cmd = Join-Path $env:SystemRoot 'System32\cmd.exe'
$Tar = Join-Path $env:SystemRoot 'System32\tar.exe'
$PowerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
# What the steps find out along the way (a hashtable, so functions can change it).
$S = @{ Built = $false; NodeNext = $false; Force = $false; ConfigChanged = $false; Password = ''; PathNote = '' }

function Say([string]$Text) { Write-Host $Text }
function Ok([string]$Text) {
  Write-Host '  ' -NoNewline; Write-Host ([char]0x2713) -ForegroundColor Green -NoNewline; Write-Host " $Text"
}
function Die([string]$Text) { $S.Died = $true; throw $Text }

function Show-Usage {
  Say @'
Usage: install.ps1 [options]   (with irm: & ([scriptblock]::Create((irm <url>))) [options])
  --port N           Port to use (default 3002)
  --public           Reachable from other devices, with a generated password
  --ref BRANCH|TAG   Version to install (default: stable, the latest release)
  --dir DIR          Install folder (default: %LOCALAPPDATA%\cubex)
  --no-start         Don't start Cubex afterwards
  --no-service       Plain background process, no scheduled task
  --no-modify-path   Don't add the cubex command to your PATH
  --force            Rebuild even if already up to date
  --source DIR       Install from a local checkout instead of GitHub
-Public, -NoStart and the like work too.
'@
}

function Read-Options([string[]]$Given) { # a hashtable of the options, or $null after --help
  $o = @{ Port = ''; Public = $false; Ref = ''; Dir = ''; Source = ''; NoStart = $false; NoService = $false
    NoPath = $false; Force = $false }
  for ($i = 0; $i -lt $Given.Count; $i++) {
    $name = ($Given[$i] -replace '^-+', '' -replace '-', '').ToLowerInvariant()
    $value = if ($i + 1 -lt $Given.Count) { $Given[$i + 1] } else { '' }
    switch ($name) {
      'port' { if (-not $value) { Die '--port needs a number' }; $o.Port = $value; $i++ }
      'ref' { if (-not $value) { Die '--ref needs a branch or tag' }; $o.Ref = $value; $i++ }
      'dir' { if (-not $value) { Die '--dir needs a folder' }; $o.Dir = $value; $i++ }
      'source' { if (-not $value) { Die '--source needs a folder' }; $o.Source = $value; $i++ }
      'public' { $o.Public = $true }
      'nostart' { $o.NoStart = $true }
      'noservice' { $o.NoService = $true }
      'nomodifypath' { $o.NoPath = $true }
      'force' { $o.Force = $true }
      { 'h', 'help', '?' -contains $_ } { Show-Usage; return $null }
      default { Show-Usage; Die "Unknown option: $($Given[$i])" }
    }
  }
  if ($o.Port -and ($o.Port -notmatch '^[0-9]+$' -or [int]$o.Port -lt 1 -or [int]$o.Port -gt 65535)) {
    Die '--port needs a number from 1 to 65535.'
  }
  $o
}

# Runs a cmd.exe line exactly as written, output to $Log or nowhere; $true when it succeeds. Paths go in as $Vars,
# read in the line as %NAME%: cmd expands those once, so a % in a folder name stays text.
function Invoke-Cmd([string]$Line, [string]$In = $env:SystemRoot, [string]$Log = '', [hashtable]$Vars = @{}) {
  $out = '>nul 2>&1'
  if ($Log) { $Vars['CUBEX_CMD_LOG'] = $Log; $out = '> "%CUBEX_CMD_LOG%" 2>&1' }
  $psi = New-Object Diagnostics.ProcessStartInfo $Cmd, "/d /v:off /s /c `"($Line) $out`""
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
  $p.ExitCode -eq 0
}

# rd, not Remove-Item: Windows PowerShell's Remove-Item -Recurse follows folder links into their targets.
function Remove-Tree([string]$Path) {
  for ($i = 0; $i -lt 20 -and (Test-Path -LiteralPath $Path); $i++) {
    if ($i) { Start-Sleep -Milliseconds 500 } # a file a program just let go of can stay locked for a moment
    if (Test-Path -LiteralPath $Path -PathType Leaf) { Remove-Item -LiteralPath $Path -Force -ErrorAction Ignore }
    else { [void](Invoke-Cmd 'rd /s /q "%CUBEX_RD%"' -Vars @{ CUBEX_RD = $Path }) }
  }
  if (Test-Path -LiteralPath $Path) { Die "Couldn't delete $Path, a program still has a file in it open." }
}

function Move-Folder([string]$From, [string]$To) {
  for ($i = 0; ; $i++) {
    try { [IO.Directory]::Move($From, $To); return }
    catch { if ($i -ge 20) { Die "Couldn't move $From, a program still has a file in it open." } }
    Start-Sleep -Milliseconds 500
  }
}

# Windows can give a folder its short 8.3 alias (C:\Users\FIRST~1.LAS) and PowerShell's file commands trip over
# those: name each existing folder on the path by its long name.
function Get-LongPath([string]$Path) {
  $parts = $Path.TrimEnd('\').Split('\')
  if ($Path -notmatch '^[A-Za-z]:\\' -or $parts.Count -lt 2) { return $Path.TrimEnd('\') }
  $long = $parts[0]
  foreach ($part in $parts[1..($parts.Count - 1)]) {
    $found = if ($part.Contains('~') -and [IO.Directory]::Exists("$long\")) {
      @([IO.Directory]::GetFileSystemEntries("$long\", $part))[0]
    }
    $long = if ($found) { $found } else { "$long\$part" }
  }
  $long
}

function New-WebClient([string]$Accept = '') {
  $web = New-Object Net.WebClient
  $web.Headers['User-Agent'] = 'cubex-install'
  if ($Accept) { $web.Headers['Accept'] = $Accept }
  $web.Encoding = [Text.Encoding]::UTF8
  $web
}

function Get-Arch { # the machine's processor, not this PowerShell's: an x64 PowerShell on an ARM64 PC says AMD64
  if ([Environment]::OSVersion.Platform -ne 'Win32NT') {
    Die 'This installer is for Windows. On macOS and Linux, use install.sh (see the README).'
  }
  $build = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').CurrentBuildNumber -as [int]
  if ($build -lt 17763) { Die 'Cubex needs Windows 10 version 1809 or newer, or Windows 11.' }
  $key = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
  $machine = (Get-ItemProperty $key).PROCESSOR_ARCHITECTURE
  if ($machine -eq 'AMD64') { return 'x64' }
  if ($machine -eq 'ARM64') { return 'arm64' }
  Die "Cubex runs on 64-bit Windows with an Intel or AMD (x64) or an ARM64 processor; this PC has $machine."
}

# The cubex command is a script Windows PowerShell runs with -ExecutionPolicy Bypass, which Group Policy outranks:
# AllSigned or Restricted set there, or a locked-down PowerShell, and no cubex command could run. Asked of Windows
# PowerShell itself, whichever PowerShell runs this (-Command isn't a script, so the policy doesn't stop the question).
function Assert-ScriptsCanRun {
  $ask = 'Get-ExecutionPolicy -Scope MachinePolicy; Get-ExecutionPolicy -Scope UserPolicy; ' +
    '$ExecutionContext.SessionState.LanguageMode'
  try { $answer = @(& $PowerShellExe -NoLogo -NoProfile -NonInteractive -Command $ask) } catch { return }
  $answer = @($answer | ForEach-Object { "$_".Trim() })
  $policy = @($answer | Select-Object -First 2 | Where-Object { 'AllSigned', 'Restricted' -contains $_ })
  if ($policy) {
    Die ("Group Policy sets PowerShell's execution policy on this PC to $($policy[0]), so the cubex command (a " +
      'PowerShell script) can''t run. Ask whoever manages this PC, or use WSL2 or Docker.')
  }
  if ($answer.Count -ge 3 -and $answer[2] -ne 'FullLanguage') {
    Die ("Windows PowerShell is locked down on this PC ($($answer[2])), so the cubex command can't run. Ask whoever " +
      'manages this PC, or use WSL2 or Docker.')
  }
}

# Elevated ("Run as administrator") while this user also has a normal, limited token. Off when UAC is, and for the
# built-in Administrator without Admin Approval Mode: there every window is elevated alike. (bin/cubex-service.ps1
# has the same check.)
function Test-SplitElevated {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $admin = [Security.Principal.WindowsBuiltInRole]::Administrator
  if (-not (New-Object Security.Principal.WindowsPrincipal $id).IsInRole($admin)) { return $false }
  $uac = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -ErrorAction Ignore
  if ($uac -and $uac.EnableLUA -eq 0) { return $false }
  -not ($id.User.Value -match '-500$' -and -not ($uac -and $uac.FilterAdministratorToken -eq 1))
}

function Install-Cubex($o) {
  Write-Host "Installing Cubex into $CubexHome" -ForegroundColor White
  $adopt = -not (Test-Path -LiteralPath "$CubexHome\$Marker")
  if (-not (Test-Path -LiteralPath $CubexHome)) {
    New-Item -ItemType Directory -Path $CubexHome | Out-Null
    $S.NewHome = $true
  }
  # Each time the marker goes into a folder (made just now, or an empty one that was there), and whenever
  # everyone's access has crept back in.
  if ($adopt -or (Test-OpenHome)) { Protect-Home }
  New-Item -ItemType Directory -Force -Path "$CubexHome\logs" | Out-Null
  [IO.File]::WriteAllText("$CubexHome\$Marker",
    "This folder is a Cubex install. `"cubex uninstall --delete-data`" removes it.`r`n")
  try { New-Item -ItemType Directory -Path "$CubexHome\.install-lock" | Out-Null; $S.Locked = $true }
  catch { Die "Another install or update is running. If not, delete $CubexHome\.install-lock and try again." }

  Install-Node
  Write-Config $o
  if (Get-Source $o.Source) { Build-App; $S.Built = $true }
  else { Ok "Already up to date ($(Get-Content -LiteralPath "$CubexHome\app\.cubex-version" -TotalCount 1))" }
  # Before starting anything, so `cubex logs` and `cubex uninstall` work even if the start fails; again once the
  # launcher has added its PATH entry, which uninstall takes off again.
  $S.PathAdded = Get-PathAdded
  Save-InstallEnv $o
  Install-Launcher $o.NoPath
  Save-InstallEnv $o
  if ($S.Built -or $S.NodeNext) { Enable-NewVersion $o.NoStart }
  elseif ($S.ConfigChanged -and (Invoke-Cli 'is-active')) {
    if (Invoke-Cli 'restart', '--quiet') { Ok 'Restarted Cubex with the new settings' }
  }
  Remove-Tree "$CubexHome\node.previous"
  Show-Finish $o.Public
}

# Yours alone (plus Windows itself and administrators), like chmod 700: a folder made with --dir somewhere like
# C:\cubex, or an empty one that was there, would otherwise let every user of this PC read the data and change
# the app.
function Protect-Home {
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & icacls.exe $CubexHome /inheritance:r /grant:r "*${me}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' |
    Out-Null
  # Grants of its own, which /inheritance:r keeps, to everyone, all signed-in users, Users and Interactive.
  if (-not $LASTEXITCODE) {
    & icacls.exe $CubexHome /remove:g '*S-1-1-0' '*S-1-5-11' '*S-1-5-32-545' '*S-1-5-4' | Out-Null
  }
  if ($LASTEXITCODE) { Die "Couldn't make $CubexHome private to you." }
}

function Test-OpenHome { # does everyone, every signed-in user, Users or Interactive have any access to the folder?
  $broad = 'S-1-1-0', 'S-1-5-11', 'S-1-5-32-545', 'S-1-5-4'
  $sid = [Security.Principal.SecurityIdentifier]
  try { $rules = @((Get-Acl -LiteralPath $CubexHome).GetAccessRules($true, $true, $sid)) } catch { return $false }
  $open = @($rules | Where-Object { "$($_.AccessControlType)" -eq 'Allow' } |
    Where-Object { $broad -contains "$($_.IdentityReference)" })
  $open.Count -gt 0
}

# The PATH entries earlier installs added, as install.env keeps them (uninstall takes exactly those off).
function Get-PathAdded {
  $file = "$CubexHome\install.env"
  if (-not (Test-Path -LiteralPath $file)) { return '' }
  $line = @([IO.File]::ReadAllLines($file) | Where-Object { $_ -like 'CUBEX_PATH_ADDED=*' })
  if ($line) { return $line[0].Substring('CUBEX_PATH_ADDED='.Length) }
  if ($BinDir -eq "$CubexHome\bin") { return $BinDir } # written before it kept them: only its own bin was added
  ''
}

function Save-InstallEnv($o) {
  [IO.File]::WriteAllText("$CubexHome\install.env", "CUBEX_FORMAT=2`r`nCUBEX_REPO=$Repo`r`nCUBEX_REF=$Ref`r`n" +
    "CUBEX_SOURCE=$($o.Source)`r`nCUBEX_BIN_DIR=$BinDir`r`nCUBEX_PATH_ADDED=$($S.PathAdded)`r`n")
}

# The latest Node.js $NodeMajor for this processor, checksum-verified, unpacked into node.next. It replaces node
# only once Cubex is stopped (Windows won't replace a program that's running). Native modules are built against it
# and it's the only Node Cubex runs on, so installing or upgrading Node elsewhere can't break Cubex.
function Install-Node {
  $base = "https://nodejs.org/dist/latest-v$NodeMajor.x"
  try { $sums = (New-WebClient).DownloadString("$base/SHASUMS256.txt") } catch { $sums = '' }
  $line = $sums -split "`n" | Where-Object { $_ -match " node-v[0-9.]+-win-$Arch\.zip$" } | Select-Object -First 1
  if (-not $line) { Die "Couldn't find Node.js $NodeMajor for Windows $Arch (no internet connection?)." }
  $hash, $file = $line.Trim() -split '\s+'
  $version = $file -replace '^node-(v[0-9.]+)-.*$', '$1'
  $current = ''
  if (Test-Path -LiteralPath "$CubexHome\node\.version") {
    $current = Get-Content -LiteralPath "$CubexHome\node\.version" -TotalCount 1
  }
  if ($current -ne $version) {
    $zip = Join-Path $Tmp $file
    try { (New-WebClient).DownloadFile("$base/$file", $zip) } catch { Die 'Downloading Node.js failed.' }
    if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne $hash) {
      Die 'The Node.js download failed its checksum.'
    }
    $next = "$CubexHome\node.next"
    Remove-Tree $next
    New-Item -ItemType Directory -Path $next | Out-Null
    & $Tar -xf $zip -C $next --strip-components 1
    if ($LASTEXITCODE) { Die 'Unpacking Node.js failed.' }
    [IO.File]::WriteAllText("$next\.version", "$version`r`n")
    $S.NodeNext = $true
    # Another major version means another native-module ABI: the app must be rebuilt.
    if ($current.Split('.')[0] -ne $version.Split('.')[0]) { $S.Force = $true }
  }
  Ok "Node.js $version (a private copy; your system Node is untouched)"
}

# config.env holds your settings. It is created once and never overwritten; options change only their own lines.
function Write-Config($o) {
  if (-not (Test-Path -LiteralPath $Config)) {
    [IO.File]::WriteAllLines($Config, [string[]]@(
      '# Cubex settings, one KEY=value per line. After a change, run: cubex restart'
      '# Every setting is listed in docs/configuration.md.'
      ''
      '# Who can open Cubex. 127.0.0.1: only this computer. 0.0.0.0: any device that'
      "# can reach it; then also set INITIAL_PASSWORD, and put HTTPS in front if it's"
      '# reachable from the internet.'
      'HOST=127.0.0.1'
      'PORT=3002'
      ''
      '# MAX_ROWS_PER_SHEET=1000000'
      '# MAX_COLUMNS_PER_SHEET=200'
      '# MAX_CSV_UPLOAD_MB=500'
    ))
  }
  if ($o.Port) { Set-Config 'PORT' $o.Port }
  if ($o.NoService) { Set-Config 'CUBEX_SERVICE' 'none' }
  # Saved once, so every later `cubex` command agrees on it.
  if (-not (Get-ConfigLine 'CUBEX_SERVICE')) { Set-Config 'CUBEX_SERVICE' (Get-ServiceMode $o) }
  if ($o.Public) {
    Set-Config 'HOST' '0.0.0.0'
    # Used only if Cubex has no account yet; Show-Finish checks which password is real.
    if (-not (Get-ConfigLine 'INITIAL_PASSWORD')) {
      $bytes = New-Object byte[] 15
      [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
      $S.Password = [Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_')
      Set-Config 'INITIAL_PASSWORD' $S.Password
    }
  }
}

# How Cubex will run: a logon task needs a desktop session (not session 0, where services and some CI runners live).
function Get-ServiceMode($o) {
  if ($o.NoService) { return 'none' }
  $line = if (Test-Path -LiteralPath $Config) { Get-ConfigLine 'CUBEX_SERVICE' }
  if ($line -and $line -ne 'CUBEX_SERVICE=auto') { return $line.Substring('CUBEX_SERVICE='.Length) }
  $desktop = (Get-Process -Id $PID).SessionId -ne 0
  $tasks = [bool](Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)
  if ($desktop -and $tasks) { 'task' } else { 'none' }
}

function Get-ConfigLine([string]$Key) { # the KEY=value line with a value, if there is one
  [IO.File]::ReadAllLines($Config) | Where-Object { $_ -match "^$Key=." } | Select-Object -First 1
}

function Set-Config([string]$Key, [string]$Value) { # replace the lines for KEY, or append one
  $lines = @([IO.File]::ReadAllLines($Config))
  if ($lines -ccontains "$Key=$Value") { return }
  $S.ConfigChanged = $true
  if ($lines -match "^$Key=") { $lines = $lines -replace "^$Key=.*$", "$Key=$Value" } else { $lines += "$Key=$Value" }
  [IO.File]::WriteAllLines($Config, [string[]]$lines)
}

# The newest published release's tag, or main while the repository has none yet.
function Get-LatestRelease {
  try {
    $req = [Net.HttpWebRequest]::Create("https://github.com/$Repo/releases/latest")
    $req.Method = 'HEAD'; $req.AllowAutoRedirect = $false; $req.UserAgent = 'cubex-install'
    $res = $req.GetResponse()
    try { $location = $res.Headers['Location'] } finally { $res.Close() }
  } catch { Die "Couldn't reach GitHub to look up the latest Cubex release. Check your internet connection." }
  if ($location -match '/releases/tag/([^/?#]+)$') { return $Matches[1] }
  'main'
}

# Puts the source in app.next and sets SrcId. Returns $false when the installed app is already this exact version.
function Get-Source([string]$Source) {
  $next = "$CubexHome\app.next"
  Remove-Tree $next
  New-Item -ItemType Directory -Path $next | Out-Null
  if ($Source) {
    # Tracked and new files only: never node_modules, data or .env secrets.
    $files = & git -C $Source -c core.quotepath=off ls-files --cached --others --exclude-standard
    if ($LASTEXITCODE) { Die "Copying $Source failed (it must be a git checkout of Cubex)." }
    $files = @($files | Where-Object { "/$_" -notmatch '/node_modules(/|$)' -and [IO.File]::Exists("$Source\$_") })
    [IO.File]::WriteAllText("$Tmp\files.txt", ($files -join "`n") + "`n")
    & $Tar -cf "$Tmp\source.tar" -C $Source -T "$Tmp\files.txt"
    if (-not $LASTEXITCODE) { & $Tar -xf "$Tmp\source.tar" -C $next }
    if ($LASTEXITCODE) { Die "Copying $Source failed (it must be a git checkout of Cubex)." }
    $S.SrcId = "local $(& git -C $Source rev-parse --short HEAD) $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
  } else {
    $ref = if ($Ref -eq 'stable') { Get-LatestRelease } else { $Ref }
    $sha = ''
    $api = "https://api.github.com/repos/$Repo/commits/$ref"
    try { $sha = (New-WebClient 'application/vnd.github.sha').DownloadString($api).Trim() } catch { }
    $S.SrcId = "$ref $(if ($sha) { $sha.Substring(0, 7) })"
    $installed = "$CubexHome\app\.cubex-version"
    if ($sha -and -not $S.Force -and (Test-Path -LiteralPath $installed) -and
      (Get-Content -LiteralPath $installed -TotalCount 1) -eq $S.SrcId) {
      Remove-Tree $next
      return $false
    }
    $tarball = Join-Path $Tmp 'cubex.tar.gz'
    $url = "https://codeload.github.com/$Repo/tar.gz/$(if ($sha) { $sha } else { $ref })"
    try { (New-WebClient).DownloadFile($url, $tarball) } catch { Die "Downloading Cubex ($Repo, $ref) failed." }
    & $Tar -xzf $tarball -C $next --strip-components 1
    if ($LASTEXITCODE) { Die "Unpacking Cubex ($Repo, $ref) failed." }
    Ok "Downloaded Cubex ($($S.SrcId))"
  }
  if (-not (Test-Path -LiteralPath "$next\bin\cubex.ps1")) {
    Stop-Unsupported ("This version of Cubex ($($S.SrcId.Trim())) came out before it ran on Windows. Install the " +
      "newest code instead: add --ref main, or run `$env:CUBEX_REF='main' before the irm line.")
  }
  # A one-command install never needs a compiler: stop before npm would reach for one.
  $lock = "$next\package-lock.json"
  if ($Arch -eq 'arm64' -and (Select-String -LiteralPath $lock -SimpleMatch '"node_modules/argon2"' -Quiet)) {
    Stop-Unsupported ('Cubex doesn''t run on Windows on ARM yet: one of its parts (argon2) has no ready-made ARM64 ' +
      'build for Windows, and installing must never need a compiler. Until a release adds it, use install.sh in WSL2.')
  }
  $true
}

# A version that can't run here: nothing is swapped in, and what this run added goes again (all of it, when this
# run made the folder), so no half-installed Cubex is left without a cubex command to remove it.
function Stop-Unsupported([string]$Why) {
  Remove-Tree "$CubexHome\app.next"
  Remove-Tree "$CubexHome\node.next"
  if ($S.NewHome) { Remove-Tree $CubexHome }
  Die $Why
}

function Build-App {
  $next = "$CubexHome\app.next"
  $log = "$CubexHome\logs\install.log"
  Say '  Building Cubex; this takes a few minutes...'
  $nodeDir = if ($S.NodeNext) { "$CubexHome\node.next" } else { "$CubexHome\node" }
  $savedPath = $env:Path; $savedNotifier = $env:npm_config_update_notifier
  try {
    $env:Path = "$nodeDir;$env:Path"
    $env:npm_config_update_notifier = 'false'
    $steps = 'npm ci --include=dev --no-audit --no-fund && npm run build && npm prune --omit=dev --no-audit --no-fund'
    $built = Invoke-Cmd $steps $next $log
  } finally { $env:Path = $savedPath; $env:npm_config_update_notifier = $savedNotifier }
  if (-not $built) {
    Remove-Tree "$CubexHome\node.next"
    Get-Content -LiteralPath $log -Tail 25 -Encoding UTF8 | Out-Host
    Die ("Building Cubex failed (full log: $log). If the log mentions node-gyp, a part of Cubex has no ready-made " +
      "build for this PC: please report it at https://github.com/$Repo/issues.")
  }
  [IO.File]::WriteAllText("$next\.cubex-version", "$($S.SrcId)`r`n")
  Ok 'Built Cubex'
}

# The `cubex` command, run by Windows PowerShell whatever runs this script. -Output returns what it prints;
# otherwise it writes straight to this console (in order with its errors), and the answer is whether it succeeded.
function Invoke-Cli([string[]]$CliArgs, [switch]$Output) {
  $cli = "$CubexHome\app\bin\cubex.ps1"
  $flags = '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'
  if ($Output) { return & $PowerShellExe @flags $cli @CliArgs }
  $psi = New-Object Diagnostics.ProcessStartInfo $PowerShellExe, "$flags `"$cli`" $($CliArgs -join ' ')"
  $psi.UseShellExecute = $false
  $p = [Diagnostics.Process]::Start($psi)
  $p.WaitForExit()
  $p.ExitCode -eq 0
}

# Swap the new Node and build in. If Cubex was running (or this is a first install) it restarts on the new version;
# if that fails, the previous one comes back.
function Enable-NewVersion([bool]$NoStart) {
  $names = @(if ($S.NodeNext) { 'node' }; if ($S.Built) { 'app' })
  # Cleared while Cubex still runs: a file open in there then stops the update before anything is stopped.
  foreach ($name in $names) { Remove-Tree "$CubexHome\$name.previous" }
  $wasRunning = $true
  if (Test-Path -LiteralPath "$CubexHome\app\bin\cubex.ps1") {
    if (Invoke-Cli 'is-active') { [void](Invoke-Cli 'stop', '--quiet') } else { $wasRunning = $false }
  }
  $swapped = @()
  try {
    foreach ($name in $names) { Switch-Folder $name; $swapped += $name }
  } catch {
    # Half swapped is worse than not at all: put back what was swapped, and start the old version again.
    foreach ($name in $swapped) {
      $current = "$CubexHome\$name"
      Move-Folder $current "$current.next"
      if (Test-Path -LiteralPath "$current.previous") { Move-Folder "$current.previous" $current }
    }
    if ($wasRunning -and (Test-Path -LiteralPath "$CubexHome\app\bin\cubex.ps1")) {
      [void](Invoke-Cli 'start', '--quiet')
    }
    throw
  }
  if ($NoStart -or -not $wasRunning) { return }
  if (Invoke-Cli 'start', '--quiet') { Ok 'Started Cubex'; return }
  $oldApp = $S.Built -and (Test-Path -LiteralPath "$CubexHome\app.previous")
  $oldNode = $S.NodeNext -and (Test-Path -LiteralPath "$CubexHome\node.previous")
  if (-not ($oldApp -or $oldNode)) { Die "Cubex didn't start. See: cubex logs" }
  $failed = ''
  if ($oldApp) {
    Remove-Tree "$CubexHome\app.failed"
    Move-Folder "$CubexHome\app" "$CubexHome\app.failed"
    Move-Folder "$CubexHome\app.previous" "$CubexHome\app"
    $failed = " The failed build is in $CubexHome\app.failed."
  }
  if ($oldNode) {
    Remove-Tree "$CubexHome\node.failed"
    Move-Folder "$CubexHome\node" "$CubexHome\node.failed"
    Move-Folder "$CubexHome\node.previous" "$CubexHome\node"
    $failed += " The new Node.js is in $CubexHome\node.failed."
  }
  [void](Invoke-Cli 'start', '--quiet')
  Die "The new version didn't start, so the previous one is back.$failed"
}

function Switch-Folder([string]$Name) { # <name>.next becomes <name>; the one it replaces becomes <name>.previous
  $current = "$CubexHome\$Name"
  if (Test-Path -LiteralPath $current) { Move-Folder $current "$current.previous" }
  try { Move-Folder "$current.next" $current }
  catch { if (Test-Path -LiteralPath "$current.previous") { Move-Folder "$current.previous" $current }; throw }
}

# The `cubex` command is a tiny launcher, so nothing else (no node) lands on PATH.
function Install-Launcher([bool]$NoPath) {
  $shim = Join-Path $BinDir 'cubex.cmd'
  New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
  $hadShim = Test-Path -LiteralPath $shim
  if ($hadShim -and -not (Select-String -LiteralPath $shim -SimpleMatch 'Cubex launcher' -Quiet)) {
    Die "$shim already exists and isn't Cubex's. Move it away and run this again."
  }
  # Inside the Cubex folder, the launcher finds it from its own place, whatever characters its path has.
  $homeRef = if ($BinDir -eq "$CubexHome\bin") { '%~dp0..' } else { $CubexHome -replace '%', '%%' }
  $run = '"%CUBEX_PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%CUBEX_HOME%\app\bin\cubex.ps1" %*'
  $text = @(
    '@echo off'
    'rem Cubex launcher, written by install.ps1: runs app\bin\cubex.ps1 with Windows PowerShell.'
    'setlocal DisableDelayedExpansion'
    "set `"CUBEX_HOME=$homeRef`""
    'set "CUBEX_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"'
    'rem One line, read once: uninstall deletes this file while it runs, and cmd reads a batch file as it goes.'
    ("if /i `"%~1`"==`"uninstall`" ($run & (goto) 2>nul & " +
      "call `"%SystemRoot%\System32\cmd.exe`" /d /c exit %%errorlevel%%) else ($run & call exit /b %%errorlevel%%)")
    ''
  ) -join "`r`n"
  if (-not $hadShim -or [IO.File]::ReadAllText($shim) -ne $text) {
    $oem = [Text.Encoding]::GetEncoding([Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage)
    [IO.File]::WriteAllText($shim, $text, $oem) # the code page cmd reads batch files in
  }
  if (-not $hadShim) { Ok "Added the cubex command ($shim)" }
  # The PATH new windows get (this window's may still list a folder an uninstall took off).
  $saved = @('User', 'Machine' | ForEach-Object { [Environment]::GetEnvironmentVariable('Path', $_) }) -join ';'
  if (-not (Test-InPath $saved $BinDir)) {
    # The user PATH is only ever edited on a first install, never by an update.
    if ($NoPath -or $hadShim) { $S.PathNote = "Add $BinDir to your PATH to use the cubex command."; return }
    Add-UserPath $BinDir
    $S.PathAdded = (@($S.PathAdded.Split(';') | Where-Object { $_ }) + $BinDir) -join ';'
    if ($RunAsFile) { $S.PathNote = 'Open a new terminal window first, so it finds the cubex command.' }
  }
  # And this window, when it ran the script itself.
  if (-not $RunAsFile -and -not (Test-InPath $env:Path $BinDir)) { $env:Path = "$env:Path;$BinDir" }
}

function Test-InPath([string]$PathList, [string]$Dir) {
  @($PathList.Split(';') | ForEach-Object { $_.TrimEnd('\') }) -contains $Dir.TrimEnd('\')
}

# The launcher's folder onto the user PATH, keeping the value's type: rewriting it as plain text (what
# [Environment]::SetEnvironmentVariable does) would stop entries like %USERPROFILE%\bin from expanding.
function Add-UserPath([string]$Dir) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  try {
    $old = $key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
    $kind = if ($old) { $key.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
    # Added as one entry, so uninstall can take it out again and leave the value exactly as it was.
    $new = if (-not $old) { $Dir } elseif ($old.EndsWith(';')) { "$old$Dir;" } else { "$old;$Dir" }
    $key.SetValue('Path', $new, $kind)
  } finally { $key.Close() }
  # Removing a variable that isn't there tells open programs the environment changed, and changes nothing else.
  [Environment]::SetEnvironmentVariable('CUBEX_PATH_CHANGED', $null, 'User')
}

# The HTTP status and body, straight to the server (never through a proxy set up for the internet).
function Invoke-Local([string]$Url, [string]$Body = '') {
  try {
    $req = [Net.HttpWebRequest]::Create($Url)
    $req.Proxy = $null; $req.Timeout = 5000; $req.KeepAlive = $false
    if ($Body) {
      $req.Method = 'POST'; $req.ContentType = 'application/json'
      $bytes = [Text.Encoding]::UTF8.GetBytes($Body)
      $stream = $req.GetRequestStream(); $stream.Write($bytes, 0, $bytes.Length); $stream.Close()
    }
    try { $res = $req.GetResponse() }
    catch [Net.WebException] { $res = $_.Exception.Response; if (-not $res) { throw } } # 4xx and 5xx answer too
    try { @{ Status = [int]$res.StatusCode; Body = (New-Object IO.StreamReader $res.GetResponseStream()).ReadToEnd() } }
    finally { $res.Close() }
  } catch { @{ Status = 0; Body = '' } }
}

# Ask the running server rather than guess: is first-run setup open, and does the generated password sign in?
function Show-Finish([bool]$Public) {
  Say ''
  if (Invoke-Cli 'status', '--quiet') {
    $url = Invoke-Cli 'url' -Output
    Write-Host "Cubex is running: $url" -ForegroundColor Green
    $direct = $url -replace '//localhost:', '//127.0.0.1:' # localhost tries IPv6 first, a 2 s detour on Windows
    $signIn = if ($S.Password) {
      (Invoke-Local "$direct/api/auth/login" (@{ password = $S.Password } | ConvertTo-Json -Compress)).Status
    }
    if ($signIn -eq 200) {
      Say "Sign in with the password $($S.Password) (also saved in $Config)."
    } elseif ($signIn -eq 401) { # an account that already has another password
      $kept = @([IO.File]::ReadAllLines($Config) | Where-Object { $_ -notmatch '^INITIAL_PASSWORD=' })
      [IO.File]::WriteAllLines($Config, [string[]]$kept)
      Say 'Cubex already has a password, so sign in with that one. Forgot it? Run: cubex reset-password'
    } elseif ($S.Password) { # no clear answer: keep it, it may be the one
      Say "Your generated password is $($S.Password) (saved in $Config), unless Cubex already had one."
    } elseif ((Invoke-Local "$direct/api/auth/status").Body -match '"setupRequired":true') {
      Say 'Open it and choose your password.'
    }
    if ($Public) {
      Say ('Windows may ask once whether Node.js can accept connections from your network; allowing that needs ' +
        'an administrator.')
    }
  } else {
    Write-Host 'Cubex is installed. Start it with: cubex start' -ForegroundColor White
    if ($S.Password) { Say "Your generated password is $($S.Password) (saved in $Config)." }
  }
  Say 'Manage it with: cubex status | stop | start | logs | update | uninstall'
  if ($S.PathNote) { Say $S.PathNote }
}

$savedHome = $env:CUBEX_HOME
$Tmp = ''
try {
  $o = Read-Options @(foreach ($a in $args) { [string]$a })
  if (-not $o) { return }
  if ($o.Ref) { $Ref = $o.Ref }
  if ($o.Dir) { $CubexHome = $o.Dir }
  $here = $ExecutionContext.SessionState.Path
  $CubexHome = Get-LongPath $here.GetUnresolvedProviderPathFromPSPath($CubexHome)
  $notAlone = @($env:SystemDrive, $env:SystemRoot, $env:USERPROFILE, $env:LOCALAPPDATA, $env:APPDATA) |
    ForEach-Object { "$_".TrimEnd('\') }
  if ($notAlone -contains $CubexHome -or $CubexHome -match '^[A-Za-z]:$') {
    Die "Give Cubex a folder of its own (--dir), not $CubexHome."
  }
  # npm's command shims (SET dp0=%~dp0, unquoted) break on these, so Cubex couldn't be built there.
  if ($CubexHome -match '[&^]') {
    Die "Cubex can't be built in a folder whose path has & or ^ in it ($CubexHome). Choose another with --dir."
  }
  # Never take over a folder with other things in it (uninstall deletes inside it), or someone else's.
  if ((Test-Path -LiteralPath $CubexHome) -and -not (Test-Path -LiteralPath "$CubexHome\$Marker")) {
    if (Get-ChildItem -LiteralPath $CubexHome -Force) {
      Die "$CubexHome already has other files in it. Choose a new or empty folder with --dir."
    }
    $owner = (Get-Acl -LiteralPath $CubexHome).GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($owner -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -and $owner -ne 'S-1-5-32-544') {
      Die "$CubexHome belongs to another user. Choose a folder of your own with --dir."
    }
  }
  if ($o.Source) {
    $o.Source = Get-LongPath $here.GetUnresolvedProviderPathFromPSPath($o.Source)
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Die 'Please install Git first.' }
  }
  $BinDir = if ($env:CUBEX_BIN_DIR) { Get-LongPath $env:CUBEX_BIN_DIR } else { "$CubexHome\bin" }
  $Config = "$CubexHome\config.env"
  $S.Force = $o.Force
  $Arch = Get-Arch
  Assert-ScriptsCanRun
  # A server started from an elevated window runs elevated, and a normal window can't see or stop it. (The logon
  # task always runs it unelevated.)
  if (-not $o.NoStart -and $env:CUBEX_ALLOW_ELEVATED -ne '1' -and (Get-ServiceMode $o) -eq 'none' -and
    (Test-SplitElevated)) {
    Die ('This window runs as administrator, and Cubex would too, where a normal window couldn''t stop it. Run the ' +
      'installer in a normal PowerShell window (or set CUBEX_ALLOW_ELEVATED=1 to run Cubex elevated anyway).')
  }
  if (-not (Test-Path -LiteralPath $Tar)) { Die "Windows' tar.exe is missing ($Tar), and the installer needs it." }
  # Older Windows PowerShell may offer only TLS 1.0, which GitHub and nodejs.org refuse.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072
  $env:CUBEX_HOME = $CubexHome # for the cubex commands it runs
  $Tmp = Join-Path (Get-LongPath ([IO.Path]::GetTempPath())) "cubex-install-$PID"
  New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
  Install-Cubex $o
} catch {
  Write-Host ''
  Write-Host 'Error: ' -ForegroundColor Red -NoNewline
  if ($S.Died) { Write-Host $_.Exception.Message }
  else { Write-Host "$($_.Exception.Message) ($($_.InvocationInfo.PositionMessage.Trim()))" }
  if ($RunAsFile) { exit 1 }
  $global:LASTEXITCODE = 1 # the window stays open; a script that ran this can still tell it failed
  return
} finally {
  if ($S.Locked) { Remove-Item -LiteralPath "$CubexHome\.install-lock" -Force -ErrorAction Ignore }
  if ($Tmp) { try { Remove-Tree $Tmp } catch { } }
  $env:CUBEX_HOME = $savedHome
}
if ($RunAsFile) { exit 0 }
$global:LASTEXITCODE = 0
} @args
