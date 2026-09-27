param(
  [ValidateSet("Both", "Supervisor", "Agent")]
  [string]$Mode = "Both",
  [switch]$DryRun,
  [switch]$NoStart,
  [switch]$SkipConfigCheck
)

$ErrorActionPreference = "Stop"

$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$portableNode = Join-Path $Root ".runtime\node\node.exe"
$portableNpm = Join-Path $Root ".runtime\node\npm.cmd"

if (-not (Test-Path $portableNode) -or -not (Test-Path $portableNpm)) {
  if ($DryRun) {
    $Node = (Get-Command node -ErrorAction Stop).Source
    $Npm = (Get-Command npm -ErrorAction Stop).Source
  } else {
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "scripts\windows\ensure-node.ps1") -Root $Root | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Portable Node installation failed" }
    $Node = $portableNode
    $Npm = $portableNpm
  }
} else {
  $Node = $portableNode
  $Npm = $portableNpm
}

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
$runtimeDir = Join-Path $Root ".runtime"
$supervisorNode = Join-Path $runtimeDir "Nomsod MCP Supervisor.exe"
$gatewayNode = Join-Path $runtimeDir "Nomsod MCP Gateway.exe"
$agentNode = Join-Path $runtimeDir "Nomsod MCP Agent.exe"
$workerNode = Join-Path $runtimeDir "Nomsod MCP Worker.exe"
$controlExe = Join-Path $Root "build\windows\Nomsod MCP Control.exe"

if (-not $DryRun) {
  Write-Host "Installing dependencies..."
  & $Npm install
  if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

  Write-Host "Building immutable bootstrap..."
  & $Npm run build
  if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }

  # The tray executable is locked while running on Windows. Stop only the
  # Control UI; the Supervisor/Agent continue running during this rebuild.
  & schtasks.exe /End /TN "NomsodMCP-Control" 1>$null 2>$null
  Get-Process -Name "Nomsod MCP Control" -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 300

  Write-Host "Building Nomsod MCP Control..."
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "scripts\windows\build-control.ps1") -Root $Root
  if ($LASTEXITCODE -ne 0) { throw "Nomsod MCP Control build failed" }

  New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

  foreach ($alias in @($supervisorNode, $gatewayNode, $agentNode, $workerNode)) {
    if (-not (Test-Path $alias)) {
      Copy-Item -LiteralPath $Node -Destination $alias -Force
    }
  }

  function Set-DotEnvValue {
    param([string]$Key, [string]$Value)
    $envFile = Join-Path $Root ".env"
    $lines = [Collections.Generic.List[string]]::new()
    if (Test-Path $envFile) {
      foreach ($line in [IO.File]::ReadAllLines($envFile, [Text.Encoding]::UTF8)) {
        if ($line -match ("^" + [Regex]::Escape($Key) + "=")) { continue }
        $lines.Add($line)
      }
    }
    $lines.Add($Key + "=" + $Value)
    [IO.File]::WriteAllLines($envFile, $lines, (New-Object Text.UTF8Encoding($false)))
  }

  Set-DotEnvValue "NOMSOD_GATEWAY_EXECUTABLE" $gatewayNode
  Set-DotEnvValue "NOMSOD_WORKER_EXECUTABLE" $workerNode
} else {
  Write-Host "[dry-run] skipping dependency install and binary builds"
}

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
    Command = $supervisorNode
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
    Command = $agentNode
    Arguments = $agentArgs
    WorkingDirectory = $Root
  }

  Install-Task "NomsodMCP-Agent" (New-TaskXml @params)
}

# Per-user tray control. This UI is deliberately independent from the core services.
$sidXml = Escape-Xml $CurrentSid
$controlTrigger = @"
<LogonTrigger>
  <Enabled>true</Enabled>
  <UserId>$sidXml</UserId>
</LogonTrigger>
"@

$controlPrincipal = @"
<Principal id="Author">
  <UserId>$sidXml</UserId>
  <LogonType>InteractiveToken</LogonType>
  <RunLevel>LeastPrivilege</RunLevel>
</Principal>
"@

$params = @{
  Description = "Nomsod MCP Control - system tray status and restart controls"
  TriggerXml = $controlTrigger
  PrincipalXml = $controlPrincipal
  Command = $controlExe
  Arguments = $Quote + $Root + $Quote
  WorkingDirectory = $Root
}
Install-Task "NomsodMCP-Control" (New-TaskXml @params)

$updaterScript = Join-Path $Root "scripts\windows\update.ps1"
$updaterTrigger = @"
<LogonTrigger>
  <Enabled>true</Enabled>
  <UserId>$sidXml</UserId>
</LogonTrigger>
<TimeTrigger>
  <Repetition>
    <Interval>PT1M</Interval>
    <StopAtDurationEnd>false</StopAtDurationEnd>
  </Repetition>
  <StartBoundary>$([DateTime]::Now.AddMinutes(1).ToString("s"))</StartBoundary>
  <Enabled>true</Enabled>
</TimeTrigger>
"@

$updaterPrincipal = @"
<Principal id="Author">
  <UserId>$sidXml</UserId>
  <LogonType>InteractiveToken</LogonType>
  <RunLevel>LeastPrivilege</RunLevel>
</Principal>
"@

$updaterArgs = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " +
  $Quote + $updaterScript + $Quote + " -Root " + $Quote + $Root + $Quote

$params = @{
  Description = "Nomsod MCP updater - checks release manifests every minute"
  TriggerXml = $updaterTrigger
  PrincipalXml = $updaterPrincipal
  Command = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  Arguments = $updaterArgs
  WorkingDirectory = $Root
}
if ($env:NOMSOD_UPDATE_IN_PROGRESS -ne "1") {
  Install-Task "NomsodMCP-Updater" (New-TaskXml @params)
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

if (-not $DryRun) {
  $dataDir = Join-Path $Root "data"
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
  [IO.File]::WriteAllText(
    (Join-Path $dataDir "install-role.txt"),
    $Mode + [Environment]::NewLine,
    (New-Object Text.UTF8Encoding($false))
  )
}

if (-not $NoStart -and -not $DryRun) {
  if ($Mode -in @("Both", "Supervisor")) {
    & schtasks.exe /Run /TN "NomsodMCP-Supervisor" | Out-Host
  }

  if ($Mode -in @("Both", "Agent")) {
    & schtasks.exe /Run /TN "NomsodMCP-Agent" | Out-Host
  }

  & schtasks.exe /Run /TN "NomsodMCP-Control" | Out-Host
}

Write-Host "Nomsod MCP Windows tasks installed."
Write-Host "Project: $Root"
Write-Host "Supervisor process: $supervisorNode"
Write-Host "Gateway process: $gatewayNode"
Write-Host "Agent process: $agentNode"
Write-Host "Worker process: $workerNode"
Write-Host "Control process: $controlExe"
