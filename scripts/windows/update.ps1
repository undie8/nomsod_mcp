param(
  [string]$Root = "",
  [string]$ManifestUrl = "https://mcp.nomsod.net/releases/latest/windows.json",
  [switch]$Force
)

$ErrorActionPreference = "Stop"

if (-not $Root) {
  $Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
}

$mutex = New-Object Threading.Mutex($false, "Local\NomsodMcpUpdater")
$hasLock = $false
try {
  $hasLock = $mutex.WaitOne(0)
  if (-not $hasLock) { exit 0 }

  $versionFile = Join-Path $Root "VERSION"
  $current = if (Test-Path $versionFile) { ([IO.File]::ReadAllText($versionFile)).Trim() } else { "0.0.0" }

  $headers = @{
    "Cache-Control" = "no-cache"
    "Pragma" = "no-cache"
    "User-Agent" = "Nomsod-MCP-Updater/$current"
  }
  $manifest = Invoke-RestMethod -UseBasicParsing -Headers $headers -Uri ($ManifestUrl + "?t=" + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds())

  if (-not $manifest.version -or -not $manifest.url -or -not $manifest.sha256) {
    throw "Invalid Nomsod MCP update manifest."
  }

  try {
    $currentVersion = [version]$current
    $latestVersion = [version]([string]$manifest.version)
  } catch {
    throw "Invalid semantic version in updater. current=$current latest=$($manifest.version)"
  }

  if (-not $Force -and $latestVersion -le $currentVersion) {
    exit 0
  }

  $logDir = Join-Path $Root "data\logs"
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $log = Join-Path $logDir "updater.log"
  Add-Content -Encoding UTF8 -Path $log -Value ("[{0}] updating {1} -> {2}" -f [DateTime]::UtcNow.ToString("o"), $current, $manifest.version)

  $updateRoot = Join-Path $Root "data\update-staging"
  $temp = Join-Path $updateRoot ([guid]::NewGuid().ToString("N"))
  $archive = Join-Path $temp "release.zip"
  $stage = Join-Path $temp "stage"
  New-Item -ItemType Directory -Force -Path $stage | Out-Null

  try {
    Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri ([string]$manifest.url) -OutFile $archive
    $actual = (Get-FileHash -Algorithm SHA256 -Path $archive).Hash.ToLowerInvariant()
    $expected = ([string]$manifest.sha256).ToLowerInvariant()
    if ($actual -ne $expected) {
      throw "Release checksum mismatch. Expected $expected, got $actual"
    }

    Expand-Archive -LiteralPath $archive -DestinationPath $stage -Force

    $releaseRoot = $stage
    if (-not (Test-Path (Join-Path $releaseRoot "VERSION"))) {
      $dirs = Get-ChildItem $stage -Directory
      if ($dirs.Count -eq 1 -and (Test-Path (Join-Path $dirs[0].FullName "VERSION"))) {
        $releaseRoot = $dirs[0].FullName
      } else {
        throw "Release package does not contain VERSION."
      }
    }

    $controlTask = "NomsodMCP-Control"
    & schtasks.exe /End /TN $controlTask 1>$null 2>$null
    Get-Process -Name "Nomsod MCP Control" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

    Get-ChildItem $releaseRoot -Force | ForEach-Object {
      $target = Join-Path $Root $_.Name
      if ($_.PSIsContainer) {
        if ($_.Name -in @("data", ".runtime", "build", "node_modules")) { return }
        Remove-Item $target -Recurse -Force -ErrorAction SilentlyContinue
        Copy-Item $_.FullName -Destination $target -Recurse -Force
      } else {
        if ($_.Name -eq ".env") { return }
        Copy-Item $_.FullName -Destination $target -Force
      }
    }

    $roleFile = Join-Path $Root "data\install-role.txt"
    $role = if (Test-Path $roleFile) { ([IO.File]::ReadAllText($roleFile)).Trim() } else { "Agent" }
    if ($role -notin @("Agent", "Supervisor", "Both")) { $role = "Agent" }

    $oldUpdateFlag = $env:NOMSOD_UPDATE_IN_PROGRESS
    $env:NOMSOD_UPDATE_IN_PROGRESS = "1"
    try {
      & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "scripts\windows\install.ps1") -Mode $role
    } finally {
      if ($null -eq $oldUpdateFlag) {
        Remove-Item Env:NOMSOD_UPDATE_IN_PROGRESS -ErrorAction SilentlyContinue
      } else {
        $env:NOMSOD_UPDATE_IN_PROGRESS = $oldUpdateFlag
      }
    }
    if ($LASTEXITCODE -ne 0) {
      throw "Nomsod MCP installer failed after update."
    }

    function Restart-NomsodTask {
      param([string]$TaskName)

      & schtasks.exe /End /TN $TaskName 1>$null 2>$null

      $deadline = [DateTime]::UtcNow.AddSeconds(20)
      while ([DateTime]::UtcNow -lt $deadline) {
        $query = (& schtasks.exe /Query /TN $TaskName /V /FO LIST 2>$null | Out-String)
        if ($query -notmatch '(?m)^Status:\s+Running\s*$') { break }
        Start-Sleep -Milliseconds 250
      }

      & schtasks.exe /Run /TN $TaskName 1>$null
      if ($LASTEXITCODE -ne 0) {
        throw "Failed to restart scheduled task $TaskName after update."
      }
    }

    if ($role -in @("Agent", "Both")) {
      Restart-NomsodTask "NomsodMCP-Agent"
    }
    if ($role -in @("Supervisor", "Both")) {
      Restart-NomsodTask "NomsodMCP-Supervisor"
    }

    Add-Content -Encoding UTF8 -Path $log -Value ("[{0}] update complete version={1}" -f [DateTime]::UtcNow.ToString("o"), $manifest.version)
  } finally {
    Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
  }
} catch {
  try {
    $logDir = Join-Path $Root "data\logs"
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    Add-Content -Encoding UTF8 -Path (Join-Path $logDir "updater.log") -Value ("[{0}] ERROR {1}" -f [DateTime]::UtcNow.ToString("o"), $_.Exception.Message)
  } catch {}
  throw
} finally {
  if ($hasLock) { try { $mutex.ReleaseMutex() } catch {} }
  $mutex.Dispose()
}
