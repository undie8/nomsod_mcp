param(
  [ValidateSet("Agent", "Supervisor", "Both")]
  [string]$Role = "Agent",
  [string]$InstallRoot = "",
  [string]$GatewayWs = "wss://mcp.nomsod.net/agent",
  [string]$PublicBaseUrl = "https://mcp.nomsod.net",
  [string]$PairingKey = "",
  [string]$OwnerKey = "",
  [string]$ClusterKey = "",
  [string]$DeviceName = "",
  [string]$EnrollmentToken = "",
  [switch]$PrepareOnly
)

$ErrorActionPreference = "Stop"

if ($env:NOMSOD_PUBLIC_BASE_URL -and -not $PSBoundParameters.ContainsKey("PublicBaseUrl")) {
  $PublicBaseUrl = $env:NOMSOD_PUBLIC_BASE_URL
}

$GatewayWsList = $GatewayWs

if (-not $InstallRoot) {
  $InstallRoot = Join-Path $env:LOCALAPPDATA "Nomsod MCP"
 }

function Read-Secret([string]$Prompt) {
  $secure = Read-Host $Prompt -AsSecureString
  return ([pscredential]::new("nomsod", $secure)).GetNetworkCredential().Password
}

function Ensure-Cloudflared([string]$Root) {
  $candidates = @(
    (Get-Command cloudflared.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue),
    "$env:ProgramFiles\cloudflared\cloudflared.exe",
    "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe",
    "${env:ProgramFiles(x86)}\cloudflared.exe",
    (Join-Path $Root ".runtime\cloudflared\cloudflared.exe")
  ) | Where-Object { $_ -and (Test-Path $_) }

  if ($candidates.Count -gt 0) {
    return [IO.Path]::GetFullPath([string]$candidates[0])
  }

  if (-not [Environment]::Is64BitOperatingSystem) {
    throw "Automatic cloudflared provisioning currently requires 64-bit Windows."
  }

  $runtimeDir = Join-Path $Root ".runtime\cloudflared"
  $target = Join-Path $runtimeDir "cloudflared.exe"
  New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

  Write-Host "Downloading Cloudflare connector..."
  $release = Invoke-RestMethod -UseBasicParsing -Headers @{
    "User-Agent" = "Nomsod-MCP-Installer"
    "Accept" = "application/vnd.github+json"
  } -Uri "https://api.github.com/repos/cloudflare/cloudflared/releases/latest"

  $asset = $release.assets |
    Where-Object { $_.name -eq "cloudflared-windows-amd64.exe" } |
    Select-Object -First 1

  if (-not $asset -or -not $asset.browser_download_url -or -not $asset.digest) {
    throw "Cloudflare release metadata does not contain a verifiable Windows amd64 binary."
  }

  $expected = ([string]$asset.digest -replace '^sha256:', '').ToLowerInvariant()
  $tempExe = $target + ".download"
  Invoke-WebRequest -UseBasicParsing -Headers @{ "User-Agent" = "Nomsod-MCP-Installer" } `
    -Uri ([string]$asset.browser_download_url) -OutFile $tempExe

  $actual = (Get-FileHash -Algorithm SHA256 -Path $tempExe).Hash.ToLowerInvariant()
  if ($actual -ne $expected) {
    Remove-Item $tempExe -Force -ErrorAction SilentlyContinue
    throw "cloudflared checksum mismatch. Expected $expected, got $actual"
  }

  Move-Item $tempExe $target -Force
  return $target
}

if (-not $EnrollmentToken -and $env:NOMSOD_ENROLLMENT_TOKEN) {
  $EnrollmentToken = $env:NOMSOD_ENROLLMENT_TOKEN
}

$EnrollmentBundle = $null
$GatewayPort = 34100
$PeerPort = 34104
$CloudflareTunnelId = ""
$CloudflareCredentialsBase64 = ""
$CloudflareHealthUrl = ""

if ($EnrollmentToken) {
  Write-Host "Joining Nomsod MCP cluster..."
  $EnrollmentBundle = Invoke-RestMethod -UseBasicParsing -Headers @{
    "Authorization" = "Bearer $EnrollmentToken"
    "Cache-Control" = "no-store"
    "User-Agent" = "Nomsod-MCP-Bootstrap"
  } -Uri ($PublicBaseUrl.TrimEnd('/') + "/enroll/bootstrap?platform=windows")

  if (
    -not $EnrollmentBundle -or
    -not $EnrollmentBundle.pairingToken -or
    -not $EnrollmentBundle.ownerKey -or
    -not $EnrollmentBundle.clusterKey
  ) {
    throw "Enrollment response is incomplete."
  }

  $Role = "Both"
  $PublicBaseUrl = [string]$EnrollmentBundle.publicBaseUrl
  $PairingKey = [string]$EnrollmentBundle.pairingToken
  $OwnerKey = [string]$EnrollmentBundle.ownerKey
  $ClusterKey = [string]$EnrollmentBundle.clusterKey
  $GatewayPort = [int]$EnrollmentBundle.gatewayPort
  $PeerPort = [int]$EnrollmentBundle.peerPort
  $GatewayWs = "ws://127.0.0.1:$GatewayPort/agent"
  $publicGatewayWs = (($PublicBaseUrl.TrimEnd("/") -replace "^https://", "wss://") -replace "^http://", "ws://") + "/agent"
  $GatewayWsList = "$GatewayWs,$publicGatewayWs"

  if ($EnrollmentBundle.cloudflare) {
    $CloudflareTunnelId = [string]$EnrollmentBundle.cloudflare.tunnelId
    $CloudflareCredentialsBase64 = [string]$EnrollmentBundle.cloudflare.credentialsBase64
    $CloudflareHealthUrl = [string]$EnrollmentBundle.cloudflare.healthUrl
  }

  Write-Host "Enrollment accepted. Installing this computer as Gateway + Agent."
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

if (-not $ClusterKey -and $env:NOMSOD_CLUSTER_KEY) {
  $ClusterKey = $env:NOMSOD_CLUSTER_KEY
}

$manifestUrl = $PublicBaseUrl.TrimEnd('/') + "/releases/latest/windows.json"
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

  $CloudflaredExe = ""
  $CloudflareCredentialsPath = ""

  if ($CloudflareTunnelId -and $CloudflareCredentialsBase64) {
    $CloudflaredExe = Ensure-Cloudflared $InstallRoot
    $cloudflareDir = Join-Path $InstallRoot "data\cloudflared"
    New-Item -ItemType Directory -Force -Path $cloudflareDir | Out-Null
    $CloudflareCredentialsPath = Join-Path $cloudflareDir ($CloudflareTunnelId + ".json")
    [IO.File]::WriteAllBytes(
      $CloudflareCredentialsPath,
      [Convert]::FromBase64String($CloudflareCredentialsBase64)
    )
  }

  $envFile = Join-Path $InstallRoot ".env"
  if (-not (Test-Path $envFile)) {
    $identity = Join-Path $InstallRoot "data\device.json"
    $logDir = Join-Path $InstallRoot "data\logs"
    $lines = New-Object Collections.Generic.List[string]

    if ($Role -in @("Supervisor", "Both")) {
      $lines.Add("NOMSOD_GATEWAY_HOST=127.0.0.1")
      $lines.Add("NOMSOD_GATEWAY_PORT=$GatewayPort")
      $lines.Add("NOMSOD_PUBLIC_BASE_URL=$PublicBaseUrl")
      $lines.Add("NOMSOD_OWNER_KEY=$OwnerKey")
      if ($ClusterKey) { $lines.Add("NOMSOD_CLUSTER_KEY=$ClusterKey") }
      $lines.Add("NOMSOD_RUNTIME_PORT_A=$($GatewayPort + 1)")
      $lines.Add("NOMSOD_CONTROL_PORT=$($GatewayPort + 2)")
      $lines.Add("NOMSOD_RUNTIME_PORT_B=$($GatewayPort + 3)")
      $lines.Add("NOMSOD_PEER_PORT=$PeerPort")
      $resolvedName = if ($DeviceName) { $DeviceName } else { $env:COMPUTERNAME }
      $lines.Add("NOMSOD_NODE_NAME=$resolvedName")
    }

    if ($Role -in @("Agent", "Both")) {
      $lines.Add("NOMSOD_GATEWAY_WS=$GatewayWs")
      $lines.Add("NOMSOD_GATEWAY_WS_LIST=$GatewayWsList")
      $lines.Add("NOMSOD_PAIRING_TOKEN=$PairingKey")
      $lines.Add("NOMSOD_IDENTITY_PATH=$identity")
      if ($DeviceName) { $lines.Add("NOMSOD_DEVICE_NAME=$DeviceName") }
      $lines.Add("NOMSOD_AGENT_WORKER_PORT_A=34120")
      $lines.Add("NOMSOD_AGENT_WORKER_PORT_B=34121")
      $lines.Add("NOMSOD_AGENT_GUARDIAN_HEALTH_PORT=34122")
      $lines.Add("NOMSOD_AGENT_DRAIN_TIMEOUT_MS=300000")
      $lines.Add("NOMSOD_HEARTBEAT_MS=5000")
      $lines.Add("NOMSOD_STALE_MS=45000")
      $lines.Add("NOMSOD_DNS_SERVERS=1.1.1.1,8.8.8.8")
      $lines.Add("NOMSOD_PEER_PORT=$PeerPort")
    }

    if ($PairingKey -and $Role -eq "Supervisor") {
      $lines.Add("NOMSOD_PAIRING_TOKEN=$PairingKey")
    }

    if ($CloudflaredExe -and $CloudflareCredentialsPath) {
      $lines.Add("NOMSOD_CLOUDFLARED_EXE=$CloudflaredExe")
      $lines.Add("NOMSOD_TUNNEL_ID=$CloudflareTunnelId")
      $lines.Add("NOMSOD_TUNNEL_CREDENTIALS=$CloudflareCredentialsPath")
      $lines.Add("NOMSOD_TUNNEL_ORIGIN=http://127.0.0.1:$GatewayPort")
      $lines.Add("NOMSOD_TUNNEL_HEALTH_URL=$CloudflareHealthUrl")
    }

    $lines.Add("NOMSOD_LOG_DIR=$logDir")
    New-Item -ItemType Directory -Force -Path (Split-Path $identity -Parent) | Out-Null
    [IO.File]::WriteAllLines($envFile, $lines, (New-Object Text.UTF8Encoding($false)))
  }

  if ($PrepareOnly) {
    Write-Host ""
    Write-Host "Nomsod MCP enrollment prepared without installing services."
    Write-Host "Location: $InstallRoot"
    return
  }

  Write-Host "Installing Nomsod MCP $Role..."
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $InstallRoot "scripts\windows\install.ps1") -Mode $Role
  if ($LASTEXITCODE -ne 0) { throw "Nomsod MCP service installation failed." }

  Write-Host ""
  Write-Host "Nomsod MCP $($manifest.version) installed."
  Write-Host "Location: $InstallRoot"
  Write-Host "MCP: $($PublicBaseUrl.TrimEnd('/'))/mcp"
  if ($EnrollmentToken) {
    Write-Host "Enrollment: complete"
  }
} finally {
  Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
}
