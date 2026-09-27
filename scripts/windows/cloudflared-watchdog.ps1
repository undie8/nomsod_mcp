param()

$ErrorActionPreference = "SilentlyContinue"

$TunnelId = "e714d345-837a-457f-a499-144e24e87c56"
$TaskName = "NomsodMCP-Cloudflared"
$HealthUrl = "https://mcp.nomsod.net/health"
$LogFile = "D:\projects\nomsod mcp\data\logs\cloudflared-watchdog.log"

function Write-Log([string]$Message) {
  try {
    $dir = Split-Path -Parent $LogFile
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $line = "[{0}] {1}{2}" -f ([DateTime]::UtcNow.ToString("o")), $Message, [Environment]::NewLine
    [IO.File]::AppendAllText($LogFile, $line, (New-Object Text.UTF8Encoding($false)))
  } catch {}
}

function Get-TunnelProcess {
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
