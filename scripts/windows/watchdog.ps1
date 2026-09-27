param(
  [Parameter(Mandatory = $true)]
  [string]$Root
)

$ErrorActionPreference = "SilentlyContinue"

function Get-EnvValue {
  param([string]$Name, [string]$DefaultValue)

  $envFile = Join-Path $Root ".env"
  if (-not (Test-Path $envFile)) { return $DefaultValue }

  foreach ($line in [IO.File]::ReadAllLines($envFile)) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }

    $equals = $trimmed.IndexOf("=")
    if ($equals -le 0) { continue }

    $key = $trimmed.Substring(0, $equals).Trim()
    if ($key -ne $Name) { continue }

    $value = $trimmed.Substring($equals + 1).Trim()
    if (
      ($value.StartsWith('"') -and $value.EndsWith('"')) -or
      ($value.StartsWith("'") -and $value.EndsWith("'"))
    ) {
      $value = $value.Substring(1, $value.Length - 2)
    }
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

function Write-WatchdogLog {
  param([string]$Message)

  $logDir = Join-Path $Root "data\logs"
  [IO.Directory]::CreateDirectory($logDir) | Out-Null
  $logFile = Join-Path $logDir "watchdog.log"
  $line = "[{0}] {1}{2}" -f ([DateTime]::UtcNow.ToString("o")), $Message, [Environment]::NewLine

  try {
    [IO.File]::AppendAllText($logFile, $line, (New-Object Text.UTF8Encoding($false)))
  } catch {}
}

function Test-JsonHealth {
  param([string]$Url)

  try {
    $response = Invoke-RestMethod -Uri $Url -Method Get -TimeoutSec 5
    return [bool]$response.ok
  } catch {
    return $false
  }
}

function Test-TaskExists {
  param([string]$TaskName)
  & schtasks.exe /Query /TN $TaskName 1>$null 2>$null
  return $LASTEXITCODE -eq 0
}

function Restart-NomsodTask {
  param([string]$TaskName)

  Write-WatchdogLog "Restarting task $TaskName"
  & schtasks.exe /End /TN $TaskName 1>$null 2>$null
  Start-Sleep -Seconds 1
  & schtasks.exe /Run /TN $TaskName 1>$null 2>$null
}

$gatewayHost = Format-HealthHost (Get-EnvValue "NOMSOD_GATEWAY_HOST" "127.0.0.1")
$gatewayPort = [int](Get-EnvValue "NOMSOD_GATEWAY_PORT" "3219")
$agentHealthPort = [int](Get-EnvValue "NOMSOD_AGENT_GUARDIAN_HEALTH_PORT" "3232")

$supervisorTask = "NomsodMCP-Supervisor"
$agentTask = "NomsodMCP-Agent"

if (Test-TaskExists $supervisorTask) {
  if (-not (Test-JsonHealth "http://${gatewayHost}:$gatewayPort/health")) {
    Restart-NomsodTask $supervisorTask
  }
}

if (Test-TaskExists $agentTask) {
  if (-not (Test-JsonHealth "http://127.0.0.1:$agentHealthPort/health")) {
    Restart-NomsodTask $agentTask
  }
}
