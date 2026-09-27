param(
  [ValidateSet("Agent", "Supervisor", "Both")]
  [string]$Role = "Agent",
  [string]$InstallRoot = "",
  [string]$GatewayWs = "wss://mcp.nomsod.net/agent",
  [string]$PublicBaseUrl = "https://mcp.nomsod.net",
  [string]$PairingKey = "",
  [string]$OwnerKey = "",
  [string]$DeviceName = ""
)

$ErrorActionPreference = "Stop"

if (-not $InstallRoot) {
  $InstallRoot = Join-Path $env:LOCALAPPDATA "Nomsod MCP"
}

function Read-Secret([string]$Prompt) {
  $secure = Read-Host $Prompt -AsSecureString
  return ([pscredential]::new("nomsod", $secure)).GetNetworkCredential().Password
}

if ($Role -in @("Agent", "Both") -and -not $PairingKey) {
  if ($env:NOMSOD_PAIRING_TOKEN) {
    $PairingKey = $env:NOMSOD_PAIRING_TOKEN
  } else {
    $PairingKey = Read-Secret "Nomsod MCP pairing key"
  }
}

if ($Role -in @("Supervisor", "Both") -and -not $OwnerKey) {
  if ($env:NOMSOD_OWNER_KEY) {
    $OwnerKey = $env:NOMSOD_OWNER_KEY
  } else {
    $OwnerKey = Read-Secret "Nomsod MCP owner key"
  }
}

$manifestUrl = "https://mcp.nomsod.net/releases/latest/windows.json"
$headers = @{
  "Cache-Control" = "no-cache"
  "Pragma" = "no-cache"
  "User-Agent" = "Nomsod-MCP-Bootstrap"
}

Write-Host "Fetching Nomsod MCP release manifest..."
$manifest = Invoke-RestMethod -UseBasicParsing -Headers $headers -Uri ($manifestUrl + "?t=" + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
if (-not $manifest.version -or -not $manifest.url -or -not $manifest.sha256) {
  throw "Invalid Nomsod MCP release manifest."
}

$temp = Join-Path $env:TEMP ("nomsod-mcp-install-" + [guid]::NewGuid().ToString("N"))
$archive = Join-Path $temp "release.zip"
$stage = Join-Path $temp "stage"
New-Item -ItemType Directory -Force -Path $stage | Out-Null

try {
  Write-Host "Downloading Nomsod MCP $($manifest.version)..."
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

  New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null

  Get-ChildItem $releaseRoot -Force | ForEach-Object {
    $target = Join-Path $InstallRoot $_.Name
    if ($_.PSIsContainer) {
      if ($_.Name -in @("data", ".runtime", "build", "node_modules")) { return }
      Remove-Item $target -Recurse -Force -ErrorAction SilentlyContinue
      Copy-Item $_.FullName -Destination $target -Recurse -Force
    } else {
      if ($_.Name -eq ".env") { return }
      Copy-Item $_.FullName -Destination $target -Force
    }
  }

  $envFile = Join-Path $InstallRoot ".env"
  if (-not (Test-Path $envFile)) {
    $identity = Join-Path $InstallRoot "data\device.json"
    $logDir = Join-Path $InstallRoot "data\logs"
    $lines = New-Object Collections.Generic.List[string]

    if ($Role -in @("Supervisor", "Both")) {
      $lines.Add("NOMSOD_GATEWAY_HOST=127.0.0.1")
      $lines.Add("NOMSOD_GATEWAY_PORT=3219")
      $lines.Add("NOMSOD_PUBLIC_BASE_URL=$PublicBaseUrl")
      $lines.Add("NOMSOD_OWNER_KEY=$OwnerKey")
      $lines.Add("NOMSOD_RUNTIME_PORT_A=3220")
      $lines.Add("NOMSOD_CONTROL_PORT=3221")
      $lines.Add("NOMSOD_RUNTIME_PORT_B=3222")
    }

    if ($Role -in @("Agent", "Both")) {
      $lines.Add("NOMSOD_GATEWAY_WS=$GatewayWs")
      $lines.Add("NOMSOD_PAIRING_TOKEN=$PairingKey")
      $lines.Add("NOMSOD_IDENTITY_PATH=$identity")
      if ($DeviceName) { $lines.Add("NOMSOD_DEVICE_NAME=$DeviceName") }
      $lines.Add("NOMSOD_AGENT_WORKER_PORT_A=3230")
      $lines.Add("NOMSOD_AGENT_WORKER_PORT_B=3231")
      $lines.Add("NOMSOD_AGENT_GUARDIAN_HEALTH_PORT=3232")
      $lines.Add("NOMSOD_AGENT_DRAIN_TIMEOUT_MS=300000")
      $lines.Add("NOMSOD_HEARTBEAT_MS=15000")
      $lines.Add("NOMSOD_STALE_MS=45000")
      $lines.Add("NOMSOD_DNS_SERVERS=1.1.1.1,8.8.8.8")
    }

    if ($PairingKey -and $Role -eq "Supervisor") {
      $lines.Add("NOMSOD_PAIRING_TOKEN=$PairingKey")
    }

    $lines.Add("NOMSOD_LOG_DIR=$logDir")
    New-Item -ItemType Directory -Force -Path (Split-Path $identity -Parent) | Out-Null
    [IO.File]::WriteAllLines($envFile, $lines, (New-Object Text.UTF8Encoding($false)))
  }

  Write-Host "Installing Nomsod MCP $Role..."
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $InstallRoot "scripts\windows\install.ps1") -Mode $Role
  if ($LASTEXITCODE -ne 0) { throw "Nomsod MCP service installation failed." }

  Write-Host ""
  Write-Host "Nomsod MCP $($manifest.version) installed."
  Write-Host "Location: $InstallRoot"
  Write-Host "MCP: https://mcp.nomsod.net/mcp"
} finally {
  Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
}
