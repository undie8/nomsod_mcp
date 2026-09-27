param()

$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))

function Get-EnvValue {
  param([string]$Name, [string]$DefaultValue)

  $envFile = Join-Path $Root ".env"
  if (-not (Test-Path $envFile)) { return $DefaultValue }

  foreach ($line in [IO.File]::ReadAllLines($envFile)) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }

    $equals = $trimmed.IndexOf("=")
    if ($equals -le 0) { continue }
    if ($trimmed.Substring(0, $equals).Trim() -ne $Name) { continue }

    $value = $trimmed.Substring($equals + 1).Trim().Trim('"').Trim("'")
    return $value
  }

  return $DefaultValue
}

function Format-HealthHost {
  param([string]$HostValue)

  if ([string]::IsNullOrWhiteSpace($HostValue) -or $HostValue -in @("0.0.0.0", "::", "[::]")) {
    return "127.0.0.1"
  }

  if ($HostValue.Contains(":") -and -not $HostValue.StartsWith("[")) {
    return "[$HostValue]"
  }

  return $HostValue
}

foreach ($task in @("NomsodMCP-Supervisor", "NomsodMCP-Agent", "NomsodMCP-Watchdog")) {
  Write-Host ""
  Write-Host "=== $task ==="
  & schtasks.exe /Query /TN $task /V /FO LIST 2>$null |
    Select-String "Status:|Last Run Time:|Last Result:|Task To Run:"
  if ($LASTEXITCODE -ne 0) { Write-Host "Not installed" }
}

$gatewayHost = Format-HealthHost (Get-EnvValue "NOMSOD_GATEWAY_HOST" "127.0.0.1")
$gatewayPort = [int](Get-EnvValue "NOMSOD_GATEWAY_PORT" "3219")
$agentPort = [int](Get-EnvValue "NOMSOD_AGENT_GUARDIAN_HEALTH_PORT" "3232")

Write-Host ""
Write-Host "=== Health ==="
try {
  $health = Invoke-RestMethod "http://${gatewayHost}:$gatewayPort/health" -TimeoutSec 3
  Write-Host ("Supervisor: OK pid={0} devices={1}" -f $health.supervisorPid, $health.connectedDevices)
} catch {
  Write-Host "Supervisor: unavailable"
}

try {
  $health = Invoke-RestMethod "http://127.0.0.1:$agentPort/health" -TimeoutSec 3
  Write-Host ("Agent Guardian: OK pid={0} gatewayConnected={1} workerPid={2}" -f $health.guardianPid, $health.gatewayConnected, $health.worker.pid)
} catch {
  Write-Host "Agent Guardian: unavailable"
}
