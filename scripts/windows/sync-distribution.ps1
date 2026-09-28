param(
  [string]$Root = "",
  [string]$PublicBaseUrl = ""
)

$ErrorActionPreference = "Stop"

if (-not $Root) {
  $Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
}

if (-not $PublicBaseUrl) {
  $PublicBaseUrl = if ($env:NOMSOD_PUBLIC_BASE_URL) {
    $env:NOMSOD_PUBLIC_BASE_URL.TrimEnd("/")
  } else {
    "https://mcp.nomsod.net"
  }
}
$PublicBaseUrl = $PublicBaseUrl.TrimEnd("/")

$distribution = Join-Path $Root "data\distribution"
$temp = Join-Path $Root ("data\distribution-sync\" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $temp | Out-Null

$headers = @{
  "Cache-Control" = "no-cache"
  "Pragma" = "no-cache"
  "User-Agent" = "Nomsod-MCP-Distribution-Sync"
}

function Get-ManifestVersion([string]$Path) {
  if (-not (Test-Path $Path)) { return "" }
  try {
    $value = ([IO.File]::ReadAllText($Path) | ConvertFrom-Json).version
    return [string]$value
  } catch {
    return ""
  }
}

function Sync-Platform([string]$Platform, [string]$InstallerName) {
  $stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $manifestTemp = Join-Path $temp ($Platform + ".json")
  $manifestUrl = "$PublicBaseUrl/releases/latest/$Platform.json?t=$stamp"
  Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri $manifestUrl -OutFile $manifestTemp

  $manifest = [IO.File]::ReadAllText($manifestTemp) | ConvertFrom-Json
  $version = [string]$manifest.version
  $artifactUrl = [string]$manifest.url
  $expectedSha = ([string]$manifest.sha256).ToLowerInvariant()

  if (-not $version -or -not $artifactUrl -or $expectedSha -notmatch '^[0-9a-f]{64}$') {
    throw "Invalid $Platform distribution manifest."
  }
  try { [void][version]$version } catch { throw "Invalid $Platform release version: $version" }

  $artifactUri = [Uri]$artifactUrl
  if (
    -not $artifactUri.IsAbsoluteUri -or
    $artifactUri.Scheme -notin @("https", "http") -or
    $artifactUri.AbsolutePath -notmatch ("^/releases/" + [regex]::Escape($version) + "/")
  ) {
    throw "Invalid $Platform artifact URL: $artifactUrl"
  }

  $artifactName = [IO.Path]::GetFileName($artifactUri.AbsolutePath)
  if (-not $artifactName) { throw "Invalid $Platform artifact file name." }

  $targetReleaseDir = Join-Path $distribution ("releases\" + $version)
  $targetArtifact = Join-Path $targetReleaseDir $artifactName
  $targetInstaller = Join-Path (Join-Path $distribution "install") $InstallerName
  $targetManifest = Join-Path (Join-Path $distribution "releases\latest") ($Platform + ".json")

  $localVersion = Get-ManifestVersion $targetManifest
  if (
    $localVersion -eq $version -and
    (Test-Path $targetArtifact) -and
    (Test-Path $targetInstaller)
  ) {
    $localSha = (Get-FileHash -Algorithm SHA256 -Path $targetArtifact).Hash.ToLowerInvariant()
    if ($localSha -eq $expectedSha) { return }
  }

  $artifactTemp = Join-Path $temp $artifactName
  Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri $artifactUrl -OutFile $artifactTemp
  $actualSha = (Get-FileHash -Algorithm SHA256 -Path $artifactTemp).Hash.ToLowerInvariant()
  if ($actualSha -ne $expectedSha) {
    throw "$Platform artifact checksum mismatch. Expected $expectedSha, got $actualSha"
  }

  $installerTemp = Join-Path $temp $InstallerName
  Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri "$PublicBaseUrl/install/${InstallerName}?t=$stamp" -OutFile $installerTemp

  New-Item -ItemType Directory -Force -Path $targetReleaseDir,(Split-Path $targetInstaller -Parent),(Split-Path $targetManifest -Parent) | Out-Null

  if (Test-Path $targetArtifact) {
    $existingSha = (Get-FileHash -Algorithm SHA256 -Path $targetArtifact).Hash.ToLowerInvariant()
    if ($existingSha -ne $expectedSha) {
      throw "Refusing to replace immutable release artifact with different content: $targetArtifact"
    }
  } else {
    Move-Item -LiteralPath $artifactTemp -Destination $targetArtifact
  }

  Move-Item -Force -LiteralPath $installerTemp -Destination $targetInstaller
  Move-Item -Force -LiteralPath $manifestTemp -Destination $targetManifest
}

try {
  Sync-Platform "windows" "windows.ps1"
  Sync-Platform "macos" "macos.sh"
  Write-Host "Nomsod MCP distribution mirror synchronized."
} finally {
  Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
}
