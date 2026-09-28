param(
  [string]$Root = "",
  [string]$CloudflaredExe = "",
  [string]$TunnelId = "",
  [string]$CredentialsFile = "",
  [string]$OriginUrl = "",
  [string]$HealthUrl = "",
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"

if (-not $Root) {
  $Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
} else {
  $Root = [IO.Path]::GetFullPath($Root)
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

function Escape-Xml {
  param([string]$Value)
  return [Security.SecurityElement]::Escape($Value)
}

function Quote-Arg {
  param([string]$Value)
  return '"' + $Value.Replace('"', '\"') + '"'
}

function New-TaskXml {
  param(
    [string]$Description,
    [string]$TriggerXml,
    [string]$PrincipalXml,
    [string]$Command,
    [string]$Arguments,
    [string]$WorkingDirectory
  )

  $commandXml = Escape-Xml $Command
  $argsXml = Escape-Xml $Arguments
  $workXml = Escape-Xml $WorkingDirectory
  $descriptionXml = Escape-Xml $Description

  return @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>$descriptionXml</Description>
  </RegistrationInfo>
  <Triggers>
    $TriggerXml
  </Triggers>
  <Principals>
    $PrincipalXml
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$commandXml</Command>
      <Arguments>$argsXml</Arguments>
      <WorkingDirectory>$workXml</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@
}

function Install-TaskXml {
  param([string]$TaskName, [string]$Xml)

  $taskDir = Join-Path $Root "data\service"
  New-Item -ItemType Directory -Force -Path $taskDir | Out-Null
  $xmlFile = Join-Path $taskDir ($TaskName + ".xml")
  [IO.File]::WriteAllText($xmlFile, $Xml, [Text.Encoding]::Unicode)

  & schtasks.exe /Create /TN $TaskName /XML $xmlFile /F | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to install scheduled task $TaskName"
  }
}

if (-not $CloudflaredExe) {
  $CloudflaredExe = Get-DotEnvValue "NOMSOD_CLOUDFLARED_EXE"
}
if (-not $TunnelId) {
  $TunnelId = Get-DotEnvValue "NOMSOD_TUNNEL_ID"
}
if (-not $CredentialsFile) {
  $CredentialsFile = Get-DotEnvValue "NOMSOD_TUNNEL_CREDENTIALS"
}
if (-not $OriginUrl) {
  $OriginUrl = Get-DotEnvValue "NOMSOD_TUNNEL_ORIGIN"
}
if (-not $HealthUrl) {
  $HealthUrl = Get-DotEnvValue "NOMSOD_TUNNEL_HEALTH_URL"
}

if (-not $CloudflaredExe) {
  $candidate = Get-Command cloudflared.exe -ErrorAction SilentlyContinue
  if ($candidate) { $CloudflaredExe = $candidate.Source }
}
if (-not $HealthUrl) {
  $HealthUrl = "https://mcp.nomsod.net/health"
}

if (-not $CloudflaredExe -or -not (Test-Path $CloudflaredExe)) {
  throw "cloudflared.exe is not configured or does not exist."
}
if (-not $TunnelId) {
  throw "NOMSOD_TUNNEL_ID is required."
}
if (-not $CredentialsFile -or -not (Test-Path $CredentialsFile)) {
  throw "NOMSOD_TUNNEL_CREDENTIALS is not configured or does not exist."
}
if (-not $OriginUrl) {
  throw "NOMSOD_TUNNEL_ORIGIN is required."
}

$version = ([IO.File]::ReadAllText((Join-Path $Root "VERSION"))).Trim()
if ($version -notmatch '^\d+\.\d+\.\d+$') {
  throw "Invalid VERSION value: $version"
}

$backgroundDir = Join-Path $Root ("build\windows\background\" + $version)
$tunnelExe = Join-Path $backgroundDir "Nomsod MCP Tunnel.exe"
$backgroundExe = Join-Path $backgroundDir "Nomsod MCP Background.exe"
$watchdogScript = Join-Path $Root "scripts\windows\cloudflared-watchdog.ps1"

foreach ($required in @($tunnelExe, $backgroundExe, $watchdogScript)) {
  if (-not (Test-Path $required)) {
    throw "Missing required Nomsod background component: $required"
  }
}

$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$currentSid = $currentIdentity.User.Value
$sidXml = Escape-Xml $currentSid

$userPrincipal = @"
<Principal id="Author">
  <UserId>$sidXml</UserId>
  <LogonType>InteractiveToken</LogonType>
  <RunLevel>LeastPrivilege</RunLevel>
</Principal>
"@

$tunnelTrigger = @"
<LogonTrigger>
  <Enabled>true</Enabled>
  <UserId>$sidXml</UserId>
</LogonTrigger>
"@

$watchdogStart = (Get-Date).AddMinutes(1).ToString("s")
$watchdogTrigger = @"
<LogonTrigger>
  <Enabled>true</Enabled>
  <UserId>$sidXml</UserId>
</LogonTrigger>
<TimeTrigger>
  <StartBoundary>$watchdogStart</StartBoundary>
  <Enabled>true</Enabled>
  <Repetition>
    <Interval>PT1M</Interval>
    <StopAtDurationEnd>false</StopAtDurationEnd>
  </Repetition>
</TimeTrigger>
"@

$tunnelArguments = @(
  "--exec-wait",
  (Quote-Arg $Root),
  (Quote-Arg $CloudflaredExe),
  "tunnel",
  "--no-autoupdate",
  "run",
  "--credentials-file",
  (Quote-Arg $CredentialsFile),
  "--url",
  (Quote-Arg $OriginUrl),
  $TunnelId
) -join " "

$watchdogArguments = (Quote-Arg $watchdogScript) + " " + (Quote-Arg $Root)

$tunnelParams = @{
  Description = "Nomsod MCP Cloudflare tunnel - hidden background connector"
  TriggerXml = $tunnelTrigger
  PrincipalXml = $userPrincipal
  Command = $tunnelExe
  Arguments = $tunnelArguments
  WorkingDirectory = $Root
}

$watchdogParams = @{
  Description = "Nomsod MCP Cloudflare tunnel watchdog - hidden background health check"
  TriggerXml = $watchdogTrigger
  PrincipalXml = $userPrincipal
  Command = $backgroundExe
  Arguments = $watchdogArguments
  WorkingDirectory = $Root
}

# Stop the old visible connector before replacing its task definition.
& schtasks.exe /End /TN "NomsodMCP-Cloudflared" 1>$null 2>$null
Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -ieq "cloudflared.exe" -and
    $_.CommandLine -match [Regex]::Escape($TunnelId)
  } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

Install-TaskXml "NomsodMCP-Cloudflared" (New-TaskXml @tunnelParams)
Install-TaskXml "NomsodMCP-Cloudflared-Watchdog" (New-TaskXml @watchdogParams)

if (-not $NoStart) {
  & schtasks.exe /Run /TN "NomsodMCP-Cloudflared" | Out-Null

  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  $tunnelProcess = $null
  while ([DateTime]::UtcNow -lt $deadline) {
    $tunnelProcess = Get-CimInstance Win32_Process |
      Where-Object {
        $_.Name -ieq "cloudflared.exe" -and
        $_.CommandLine -match [Regex]::Escape($TunnelId)
      } |
      Select-Object -First 1

    if ($tunnelProcess) { break }
    Start-Sleep -Milliseconds 500
  }

  if (-not $tunnelProcess) {
    throw "Hidden cloudflared connector did not start."
  }

  Write-Host "Hidden cloudflared connector started: PID $($tunnelProcess.ProcessId)"
}

Write-Host "Tunnel task: NomsodMCP-Cloudflared"
Write-Host "Watchdog task: NomsodMCP-Cloudflared-Watchdog"
Write-Host "Tunnel launcher: $tunnelExe"
