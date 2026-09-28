param(
  [string]$Root = "",
  [string]$Destination = "",
  [switch]$Force
)

$ErrorActionPreference = "Stop"

if (-not $Root) {
  $Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
}
if (-not $Destination) {
  $Destination = Join-Path ([Environment]::GetFolderPath("Desktop")) "Nomsod-Recovery-Kit-SENSITIVE.zip"
}
$Destination = [IO.Path]::GetFullPath($Destination)

if ((Test-Path $Destination) -and -not $Force) {
  throw "Destination already exists: $Destination"
}

function Read-DotEnv([string]$Path) {
  $values = @{}
  if (-not (Test-Path $Path)) { return $values }

  foreach ($line in [IO.File]::ReadAllLines($Path)) {
    if (-not $line -or $line.TrimStart().StartsWith("#")) { continue }
    $index = $line.IndexOf("=")
    if ($index -le 0) { continue }
    $key = $line.Substring(0, $index).Trim()
    $value = $line.Substring($index + 1)
    if ($key) { $values[$key] = $value }
  }
  return $values
}

function Require-Value([hashtable]$Values, [string]$Name) {
  $value = [string]$Values[$Name]
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "Required recovery value is missing: $Name"
  }
  return $value.Trim()
}

$envFile = Join-Path $Root ".env"
$values = Read-DotEnv $envFile

$publicBase = Require-Value $values "NOMSOD_PUBLIC_BASE_URL"
$pairingToken = Require-Value $values "NOMSOD_PAIRING_TOKEN"
$clusterId = if ($values["NOMSOD_CLUSTER_ID"]) { [string]$values["NOMSOD_CLUSTER_ID"] } else { "nomsod-main-v1" }
$ownerKey = if ($values["NOMSOD_OWNER_KEY"]) { [string]$values["NOMSOD_OWNER_KEY"] } else { $pairingToken }
$clusterKey = if ($values["NOMSOD_CLUSTER_KEY"]) {
  [string]$values["NOMSOD_CLUSTER_KEY"]
} else {
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes("nomsod-cluster-v1" + [char]0 + $pairingToken)
    $hash = $sha.ComputeHash($bytes)
    ([Convert]::ToBase64String($hash).TrimEnd("=") -replace '\+', '-' -replace '/', '_')
  } finally {
    $sha.Dispose()
  }
}
$tunnelId = Require-Value $values "NOMSOD_TUNNEL_ID"
$credentialsPath = Require-Value $values "NOMSOD_TUNNEL_CREDENTIALS"
$gatewayPort = if ($values["NOMSOD_GATEWAY_PORT"]) { [int]$values["NOMSOD_GATEWAY_PORT"] } else { 34100 }
$peerPort = if ($values["NOMSOD_PEER_PORT"]) { [int]$values["NOMSOD_PEER_PORT"] } else { 34104 }
$healthUrl = if ($values["NOMSOD_TUNNEL_HEALTH_URL"]) {
  [string]$values["NOMSOD_TUNNEL_HEALTH_URL"]
} else {
  $publicBase.TrimEnd("/") + "/health"
}

if (-not [IO.Path]::IsPathRooted($credentialsPath)) {
  $credentialsPath = Join-Path $Root $credentialsPath
}
$credentialsPath = [IO.Path]::GetFullPath($credentialsPath)
if (-not (Test-Path $credentialsPath)) {
  throw "Cloudflare tunnel credential file is missing."
}
$credentialsBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($credentialsPath))

$distribution = Join-Path $Root "data\distribution"
$windowsManifestPath = Join-Path $distribution "releases\latest\windows.json"
$macManifestPath = Join-Path $distribution "releases\latest\macos.json"
$windowsInstaller = Join-Path $distribution "install\windows.ps1"
$macInstaller = Join-Path $distribution "install\macos.sh"

foreach ($required in @($windowsManifestPath, $macManifestPath, $windowsInstaller, $macInstaller)) {
  if (-not (Test-Path $required)) {
    throw "Distribution mirror is incomplete: $required"
  }
}

$windowsManifest = [IO.File]::ReadAllText($windowsManifestPath) | ConvertFrom-Json
$macManifest = [IO.File]::ReadAllText($macManifestPath) | ConvertFrom-Json

function Resolve-Artifact([object]$Manifest) {
  $version = [string]$Manifest.version
  $url = [string]$Manifest.url
  $sha = ([string]$Manifest.sha256).ToLowerInvariant()
  if (-not $version -or -not $url -or $sha -notmatch '^[0-9a-f]{64}$') {
    throw "Invalid distribution manifest."
  }
  [void][version]$version
  $uri = [Uri]$url
  $name = [IO.Path]::GetFileName($uri.AbsolutePath)
  $file = Join-Path $distribution ("releases\" + $version + "\" + $name)
  if (-not (Test-Path $file)) {
    throw "Recovery artifact is missing: $file"
  }
  $actual = (Get-FileHash -Algorithm SHA256 $file).Hash.ToLowerInvariant()
  if ($actual -ne $sha) {
    throw "Recovery artifact checksum mismatch: $name"
  }
  return [pscustomobject]@{ Version = $version; Name = $name; File = $file; Sha = $sha }
}

$windowsArtifact = Resolve-Artifact $windowsManifest
$macArtifact = Resolve-Artifact $macManifest

$workspace = Join-Path ([IO.Path]::GetTempPath()) ("nomsod-recovery-export-" + [guid]::NewGuid().ToString("N"))
$kitRoot = Join-Path $workspace "Nomsod-Recovery-Kit"
$kitDistribution = Join-Path $kitRoot "distribution"

try {
  $directories = @(
    (Join-Path $kitDistribution "install"),
    (Join-Path $kitDistribution "releases\latest"),
    (Join-Path $kitDistribution ("releases\" + $windowsArtifact.Version)),
    (Join-Path $kitDistribution ("releases\" + $macArtifact.Version))
  )
  New-Item -ItemType Directory -Force -Path $directories | Out-Null

  Copy-Item $windowsInstaller (Join-Path $kitDistribution "install\windows.ps1") -Force
  Copy-Item $macInstaller (Join-Path $kitDistribution "install\macos.sh") -Force
  Copy-Item $windowsManifestPath (Join-Path $kitDistribution "releases\latest\windows.json") -Force
  Copy-Item $macManifestPath (Join-Path $kitDistribution "releases\latest\macos.json") -Force
  Copy-Item $windowsArtifact.File (Join-Path $kitDistribution ("releases\" + $windowsArtifact.Version + "\" + $windowsArtifact.Name)) -Force
  Copy-Item $macArtifact.File (Join-Path $kitDistribution ("releases\" + $macArtifact.Version + "\" + $macArtifact.Name)) -Force

  Copy-Item (Join-Path $PSScriptRoot "RECOVER-WINDOWS.ps1") (Join-Path $kitRoot "RECOVER-WINDOWS.ps1") -Force
  Copy-Item (Join-Path $PSScriptRoot "RECOVER-MACOS.sh") (Join-Path $kitRoot "RECOVER-MACOS.sh") -Force
  Copy-Item (Join-Path $PSScriptRoot "README-SENSITIVE.txt") (Join-Path $kitRoot "README-SENSITIVE.txt") -Force

  $bundle = [ordered]@{
    version = 1
    kind = "nomsod-single-cluster-recovery"
    clusterId = $clusterId
    publicBaseUrl = $publicBase.TrimEnd("/")
    gatewayPort = $gatewayPort
    peerPort = $peerPort
    pairingToken = $pairingToken
    ownerKey = $ownerKey
    clusterKey = $clusterKey
    cloudflare = [ordered]@{
      tunnelId = $tunnelId
      credentialsBase64 = $credentialsBase64
      healthUrl = $healthUrl
    }
    distribution = [ordered]@{
      windowsVersion = $windowsArtifact.Version
      macosVersion = $macArtifact.Version
    }
    createdAt = [DateTime]::UtcNow.ToString("o")
  }

  [IO.File]::WriteAllText(
    (Join-Path $kitRoot "recovery.json"),
    ($bundle | ConvertTo-Json -Depth 6),
    (New-Object Text.UTF8Encoding($false))
  )

  $parent = Split-Path $Destination -Parent
  if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  Remove-Item $Destination -Force -ErrorAction SilentlyContinue
  Compress-Archive -LiteralPath $kitRoot -DestinationPath $Destination -CompressionLevel Optimal

  Write-Host "Nomsod MCP recovery kit created."
  Write-Host "Store this ZIP outside Nomsod computers and protect it as a sensitive credential backup."
  Write-Host "Path: $Destination"
} finally {
  Remove-Item $workspace -Recurse -Force -ErrorAction SilentlyContinue
}
