param(
  [string]$Root = ""
)

$ErrorActionPreference = "SilentlyContinue"

if (-not $Root) {
  $Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
}

function Get-DotEnvValue {
  param([string]$Key)

  $envFile = Join-Path $Root ".env"
  if (-not (Test-Path $envFile)) { return "" }

  foreach ($line in [IO.File]::ReadAllLines($envFile, [Text.Encoding]::UTF8)) {
    if ($line -match ("^" + [Regex]::Escape($Key) + "=(.*)$")) {
      return $Matches[1].Trim().Trim('"').Trim("'")
    }
  }

  return ""
}

$TunnelId = Get-DotEnvValue "NOMSOD_TUNNEL_ID"
$TaskName = "NomsodMCP-Cloudflared"
$HealthUrl = Get-DotEnvValue "NOMSOD_TUNNEL_HEALTH_URL"
if (-not $HealthUrl) { $HealthUrl = "https://mcp.nomsod.net/health" }
$LogFile = Join-Path $Root "data\logs\cloudflared-watchdog.log"

function Write-Log([string]$Message) {
  try {
    $dir = Split-Path -Parent $LogFile
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $line = "[{0}] {1}{2}" -f ([DateTime]::UtcNow.ToString("o")), $Message, [Environment]::NewLine
    [IO.File]::AppendAllText($LogFile, $line, (New-Object Text.UTF8Encoding($false)))
  } catch {}
}

function Get-TunnelProcess {
  if (-not $TunnelId) { return $null }

  Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -ieq "cloudflared.exe" -and
      $_.CommandLine -match [Regex]::Escape($TunnelId)
    } |
    Select-Object -First 1
}

function Test-PublicHealth {
  try {
    $response = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 8
    return [bool]$response.ok
  } catch {
    return $false
  }
}

if (-not $TunnelId) {
  Write-Log "NOMSOD_TUNNEL_ID is not configured."
  exit 2
}

$proc = Get-TunnelProcess
$healthy = Test-PublicHealth

if ($proc -and $healthy) {
  exit 0
}

if ($proc) {
  Write-Log "Connector process exists but public health failed; restarting task."
  Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
} else {
  Write-Log "Connector process missing; starting task."
}

& schtasks.exe /End /TN $TaskName 1>$null 2>$null
Start-Sleep -Milliseconds 500
& schtasks.exe /Run /TN $TaskName 1>$null 2>$null
Start-Sleep -Seconds 8

$proc = Get-TunnelProcess
$healthy = Test-PublicHealth

if ($proc -and $healthy) {
  Write-Log "Connector recovered pid=$($proc.ProcessId)."
  exit 0
}

Write-Log "Connector recovery attempt did not become healthy."
exit 1
