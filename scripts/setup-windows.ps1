<#
  One-time setup of a fresh Windows (Server 2025) PC for CONSOLE_KIND=native.
  Run from the repo folder in an ADMIN PowerShell:

    powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1

  Installs only what is missing, so running it again is safe:
    1. Node.js LTS            (winget, else the official MSI from nodejs.org)
    2. Python 3               (winget, else the official installer from python.org)
    3. ffmpeg, full build with ddagrab + h264_nvenc
                              (winget Gyan.FFmpeg, else the BtbN GPL zip from GitHub into C:\ffmpeg)
    4. pip install vgamepad   and the ViGEmBus driver it needs (installed silently;
                              running this script means you accept the ViGEmBus licence)
    5. Windows Audio service  set to start automatically (off by default on Server)
    6. npm ci                 in the repo folder
  It prints one line per step: DONE (installed now), OK (was already there),
  WARN or FAIL.
#>
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Tmp = Join-Path $env:TEMP 'halcyra-setup'
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
$Report = New-Object System.Collections.ArrayList

function Say($status, $what, $detail = '') {
  $line = '{0,-5} {1}{2}' -f $status, $what, $(if ($detail) { "  ($detail)" } else { '' })
  [void]$Report.Add($line)
  $color = switch ($status) { 'DONE' { 'Green' } 'OK' { 'Gray' } 'WARN' { 'Yellow' } default { 'Red' } }
  Write-Host $line -ForegroundColor $color
}
function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function RefreshPath {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function AddMachinePath($dir) {
  $p = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  if (($p -split ';') -notcontains $dir) { [Environment]::SetEnvironmentVariable('Path', "$p;$dir", 'Machine') }
  RefreshPath
}
function Download($url, $file) {
  Write-Host "      downloading $url"
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $file
}
function WingetInstall($id) {
  & winget install --id $id --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity | Out-Host
  return ($LASTEXITCODE -eq 0 -or $LASTEXITCODE -eq -1978335189)  # 0x8A15002B = already installed
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Write-Host 'Run this in an ADMIN PowerShell (right click PowerShell, Run as administrator).' -ForegroundColor Red; exit 1 }
$HasWinget = Has 'winget'
Write-Host "halcyra setup in $Repo (winget: $(if ($HasWinget) { 'yes' } else { 'no, using direct downloads' }))`n"
RefreshPath

# ---------------------------------------------------------------- 1. Node.js LTS
try {
  $nodeMajor = 0
  if (Has 'node') { $nodeMajor = [int]((& node -v).TrimStart('v').Split('.')[0]) }
  if ($nodeMajor -ge 20) { Say 'OK' 'Node.js' (& node -v) }
  else {
    $done = $false
    if ($HasWinget) { $done = WingetInstall 'OpenJS.NodeJS.LTS' }
    if (-not $done) {
      $idx = Invoke-RestMethod -UseBasicParsing 'https://nodejs.org/dist/index.json'
      $lts = $idx | Where-Object { $_.lts } | Select-Object -First 1
      $msi = Join-Path $Tmp "node-$($lts.version)-x64.msi"
      Download "https://nodejs.org/dist/$($lts.version)/node-$($lts.version)-x64.msi" $msi
      Start-Process msiexec.exe -Wait -ArgumentList "/i `"$msi`" /qn /norestart"
    }
    RefreshPath
    if (Has 'node') { Say 'DONE' 'Node.js' (& node -v) } else { Say 'FAIL' 'Node.js' 'installed but not on PATH; open a new PowerShell and run this again' }
  }
} catch { Say 'FAIL' 'Node.js' $_.Exception.Message }

# ---------------------------------------------------------------- 2. Python 3
function PythonOk { if (-not (Has 'python')) { return $false }; $v = (& python --version 2>&1) -join ''; return ($v -match 'Python 3\.(\d+)') -and ([int]$Matches[1] -ge 8) }
try {
  if (PythonOk) { Say 'OK' 'Python' ((& python --version 2>&1) -join '') }
  else {
    $done = $false
    if ($HasWinget) { $done = WingetInstall 'Python.Python.3.12' }
    if (-not $done) {
      $ver = '3.12.10'
      $exe = Join-Path $Tmp "python-$ver-amd64.exe"
      Download "https://www.python.org/ftp/python/$ver/python-$ver-amd64.exe" $exe
      Start-Process $exe -Wait -ArgumentList '/quiet InstallAllUsers=1 PrependPath=1 Include_test=0'
    }
    RefreshPath
    if (PythonOk) { Say 'DONE' 'Python' ((& python --version 2>&1) -join '') } else { Say 'FAIL' 'Python' 'not on PATH after install; open a new PowerShell and run this again (and turn off the Microsoft Store "python" alias in Settings > Apps > Advanced app settings > App execution aliases)' }
  }
} catch { Say 'FAIL' 'Python' $_.Exception.Message }

# ---------------------------------------------------------------- 3. ffmpeg (ddagrab + nvenc)
function FfmpegGood {
  if (-not (Has 'ffmpeg')) { return $false }
  $f = (& ffmpeg -hide_banner -filters 2>&1) -join "`n"
  $e = (& ffmpeg -hide_banner -encoders 2>&1) -join "`n"
  return ($f -match 'ddagrab') -and ($e -match 'h264_nvenc')
}
try {
  if (FfmpegGood) { Say 'OK' 'ffmpeg (ddagrab + h264_nvenc)' ((& ffmpeg -hide_banner -version 2>&1 | Select-Object -First 1) -join '') }
  else {
    $done = $false
    if ($HasWinget) { WingetInstall 'Gyan.FFmpeg' | Out-Null; RefreshPath; $done = FfmpegGood }
    if (-not $done) {
      $zip = Join-Path $Tmp 'ffmpeg.zip'
      Download 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip' $zip
      $out = Join-Path $Tmp 'ffmpeg-unzip'
      if (Test-Path $out) { Remove-Item -Recurse -Force $out }
      Expand-Archive -Path $zip -DestinationPath $out -Force
      $bin = Get-ChildItem -Path $out -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1
      New-Item -ItemType Directory -Force -Path 'C:\ffmpeg\bin' | Out-Null
      Copy-Item -Force (Join-Path $bin.DirectoryName '*') 'C:\ffmpeg\bin\'
      # put C:\ffmpeg\bin FIRST so an older ffmpeg elsewhere does not win
      $p = [Environment]::GetEnvironmentVariable('Path', 'Machine')
      if (($p -split ';') -notcontains 'C:\ffmpeg\bin') { [Environment]::SetEnvironmentVariable('Path', "C:\ffmpeg\bin;$p", 'Machine') }
      RefreshPath
    }
    if (FfmpegGood) { Say 'DONE' 'ffmpeg (ddagrab + h264_nvenc)' ((& ffmpeg -hide_banner -version 2>&1 | Select-Object -First 1) -join '') }
    elseif (Has 'ffmpeg') { Say 'WARN' 'ffmpeg' 'installed, but this build lacks ddagrab or h264_nvenc; the service falls back to gdigrab / libx264' }
    else { Say 'FAIL' 'ffmpeg' 'not on PATH after install' }
  }
} catch { Say 'FAIL' 'ffmpeg' $_.Exception.Message }

# ---------------------------------------------------------------- 4. vgamepad + ViGEmBus
function VigemInstalled { [bool](Get-Service -Name 'ViGEmBus' -ErrorAction SilentlyContinue) -or [bool](Get-PnpDevice -FriendlyName '*Virtual Gamepad Emulation Bus*' -ErrorAction SilentlyContinue) }
try {
  if (-not (PythonOk)) { throw 'no Python' }
  & python -c "import vgamepad" 2>$null
  $hadVg = ($LASTEXITCODE -eq 0)
  & python -m pip install --upgrade --disable-pip-version-check --quiet pip vgamepad | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'pip install vgamepad failed' }
  if ($hadVg) { Say 'OK' 'pip vgamepad' } else { Say 'DONE' 'pip vgamepad' }

  if (VigemInstalled) { Say 'OK' 'ViGEmBus driver' }
  else {
    # vgamepad carries the ViGEmBus installer; run it silently. Else the release from GitHub.
    $pkg = (& python -c "import importlib.util, os; print(os.path.dirname(importlib.util.find_spec('vgamepad').origin))").Trim()
    $inst = Get-ChildItem -Path $pkg -Recurse -Include 'ViGEmBus*.msi', 'ViGEmBus*.exe' -ErrorAction SilentlyContinue | Sort-Object { if ($_.FullName -match 'x64') { 0 } else { 1 } } | Select-Object -First 1
    if (-not $inst) {
      $exe = Join-Path $Tmp 'ViGEmBus_1.22.0_x64_x86_arm64.exe'
      Download 'https://github.com/nefarius/ViGEmBus/releases/download/v1.22.0/ViGEmBus_1.22.0_x64_x86_arm64.exe' $exe
      $inst = Get-Item $exe
    }
    Write-Host "      installing $($inst.Name)"
    if ($inst.Extension -eq '.msi') { Start-Process msiexec.exe -Wait -ArgumentList "/i `"$($inst.FullName)`" /qn /norestart" }
    else { Start-Process $inst.FullName -Wait -ArgumentList '/qn /norestart' }
    if (VigemInstalled) { Say 'DONE' 'ViGEmBus driver' $inst.Name } else { Say 'WARN' 'ViGEmBus driver' "installer ran but the driver is not listed yet; reboot, then run node scripts\native-check.mjs" }
  }
} catch { Say 'FAIL' 'vgamepad / ViGEmBus' $_.Exception.Message }

# ---------------------------------------------------------------- 5. Windows Audio
try {
  foreach ($svc in 'AudioEndpointBuilder', 'Audiosrv') {
    $s = Get-Service -Name $svc -ErrorAction SilentlyContinue
    if (-not $s) { continue }
    if ($s.StartType -ne 'Automatic') { Set-Service -Name $svc -StartupType Automatic }
    if ($s.Status -ne 'Running') { Start-Service -Name $svc }
  }
  Say 'OK' 'Windows Audio service' 'automatic + running (game sound needs an audio device; see docs/NATIVE.md for capturing it)'
} catch { Say 'WARN' 'Windows Audio service' $_.Exception.Message }

# ---------------------------------------------------------------- 6. npm ci
try {
  if (-not (Has 'npm')) { throw 'npm is not on PATH (open a new PowerShell after the Node install)' }
  Push-Location $Repo
  if (Test-Path (Join-Path $Repo 'node_modules')) { $was = 'OK' } else { $was = 'DONE' }
  if (Test-Path (Join-Path $Repo 'package-lock.json')) { & npm ci --no-audit --no-fund | Out-Host } else { & npm install --no-audit --no-fund | Out-Host }
  if ($LASTEXITCODE -ne 0) { throw "npm exited $LASTEXITCODE" }
  Pop-Location
  Say $was 'npm packages' 'npm ci'
} catch { try { Pop-Location } catch {}; Say 'FAIL' 'npm packages' $_.Exception.Message }

Write-Host "`nSummary"
$Report | ForEach-Object { Write-Host "  $_" }
Write-Host "`nNext: open a NEW PowerShell (so PATH is fresh), cd $Repo, run: node scripts\native-check.mjs"
if ($Report -match '^FAIL') { exit 1 } else { exit 0 }
