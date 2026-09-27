param(
  [ValidateSet("Both", "Supervisor", "Agent")]
  [string]$Mode = "Both",
  [switch]$DryRun,
  [switch]$NoStart,
  [switch]$SkipConfigCheck
)

$ErrorActionPreference = "Stop"

$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$Node = (Get-Command node -ErrorAction Stop).Source
$Npm = (Get-Command npm -ErrorAction Stop).Source
$CurrentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$CurrentSid = $CurrentIdentity.User.Value
$Quote = [char]34

function Test-IsAdministrator {
  $principal = New-Object Security.Principal.WindowsPrincipal($CurrentIdentity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Escape-Xml {
  param([string]$Value)
  return [Security.SecurityElement]::Escape($Value)
}

function Assert-Configuration {
  $envFile = Join-Path $Root ".env"

  if (-not (Test-Path $envFile)) {
    throw "Missing $envFile. Copy .env.example to .env and configure Nomsod before installing services."
  }

  $text = [IO.File]::ReadAllText($envFile)

  if ($Mode -in @("Both", "Supervisor")) {
    if ($text -match "change-me-long-random-secret" -or $text -match "change-me-separate-pairing-token") {
      throw ".env still contains example secrets. Replace them before installing the Supervisor."
    }
  }
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
    <Hidden>false</Hidden>
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

function Install-Task {
  param([string]$TaskName, [string]$Xml)

  $taskDir = Join-Path $Root "data\service"
  [IO.Directory]::CreateDirectory($taskDir) | Out-Null
  $xmlFile = Join-Path $taskDir ($TaskName + ".xml")

  [IO.File]::WriteAllText($xmlFile, $Xml, [Text.Encoding]::Unicode)

  if ($DryRun) {
    Write-Host "[dry-run] would install task $TaskName from $xmlFile"
    return
  }

  & schtasks.exe /Create /TN $TaskName /XML $xmlFile /F | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to install scheduled task $TaskName"
  }
}

if (-not $DryRun -and $Mode -in @("Both", "Supervisor") -and -not (Test-IsAdministrator)) {
  throw "Supervisor installation requires an elevated PowerShell window because it creates a boot task under LocalSystem."
}

if ($SkipConfigCheck -and -not $DryRun) {
  throw "-SkipConfigCheck is allowed only with -DryRun."
}

if (-not $SkipConfigCheck) {
  Assert-Configuration
}

Set-Location $Root
Write-Host "Installing dependencies..."
& $Npm install
if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

Write-Host "Building immutable bootstrap..."
& $Npm run build
if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }

$supervisorArgs = $Quote + "dist\bootstrap\supervisor.js" + $Quote
$agentArgs = $Quote + "dist\bootstrap\agent.js" + $Quote

if ($Mode -in @("Both", "Supervisor")) {
  $supervisorTrigger = @"
<BootTrigger>
  <Enabled>true</Enabled>
  <Delay>PT5S</Delay>
</BootTrigger>
"@

  $systemPrincipal = @"
<Principal id="Author">
  <UserId>S-1-5-18</UserId>
  <RunLevel>HighestAvailable</RunLevel>
</Principal>
"@

  $params = @{
    Description = "Nomsod MCP Supervisor - machine-level connection and runtime guardian"
    TriggerXml = $supervisorTrigger
    PrincipalXml = $systemPrincipal
    Command = $Node
    Arguments = $supervisorArgs
    WorkingDirectory = $Root
  }

  Install-Task "NomsodMCP-Supervisor" (New-TaskXml @params)
}

if ($Mode -in @("Both", "Agent")) {
  $sidXml = Escape-Xml $CurrentSid

  $agentTrigger = @"
<LogonTrigger>
  <Enabled>true</Enabled>
  <UserId>$sidXml</UserId>
</LogonTrigger>
"@

  $userPrincipal = @"
<Principal id="Author">
  <UserId>$sidXml</UserId>
  <LogonType>InteractiveToken</LogonType>
  <RunLevel>LeastPrivilege</RunLevel>
</Principal>
"@

  $params = @{
    Description = "Nomsod MCP Agent Guardian - user-session device connection"
    TriggerXml = $agentTrigger
    PrincipalXml = $userPrincipal
    Command = $Node
    Arguments = $agentArgs
    WorkingDirectory = $Root
  }

  Install-Task "NomsodMCP-Agent" (New-TaskXml @params)
}

if ($Mode -in @("Both", "Supervisor") -or (Test-IsAdministrator)) {
  $watchdogScript = Join-Path $Root "scripts\windows\watchdog.ps1"
  $watchdogTrigger = @"
<TimeTrigger>
  <Repetition>
    <Interval>PT1M</Interval>
    <StopAtDurationEnd>false</StopAtDurationEnd>
  </Repetition>
  <StartBoundary>$([DateTime]::Now.AddMinutes(1).ToString("s"))</StartBoundary>
  <Enabled>true</Enabled>
</TimeTrigger>
"@

  $systemPrincipal = @"
<Principal id="Author">
  <UserId>S-1-5-18</UserId>
  <RunLevel>HighestAvailable</RunLevel>
</Principal>
"@

  $watchdogArgs = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " +
    $Quote + $watchdogScript + $Quote + " -Root " + $Quote + $Root + $Quote

  $params = @{
    Description = "Nomsod MCP watchdog - restarts unhealthy Supervisor/Agent scheduled tasks"
    TriggerXml = $watchdogTrigger
    PrincipalXml = $systemPrincipal
    Command = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    Arguments = $watchdogArgs
    WorkingDirectory = $Root
  }

  Install-Task "NomsodMCP-Watchdog" (New-TaskXml @params)
} elseif ($Mode -eq "Agent") {
  Write-Warning "Agent installed without the machine-level watchdog because PowerShell is not elevated. Task Scheduler will still restart the Agent when its process exits."
}

if (-not $NoStart -and -not $DryRun) {
  if ($Mode -in @("Both", "Supervisor")) {
    & schtasks.exe /Run /TN "NomsodMCP-Supervisor" | Out-Host
  }

  if ($Mode -in @("Both", "Agent")) {
    & schtasks.exe /Run /TN "NomsodMCP-Agent" | Out-Host
  }
}

Write-Host "Nomsod MCP Windows tasks installed."
Write-Host "Project: $Root"
Write-Host "Node: $Node"
