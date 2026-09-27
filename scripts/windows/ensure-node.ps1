param(
  [string]$Root = "",
  [string]$Version = ""
)

$ErrorActionPreference = "Stop"

if (-not $Root) {
  $Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
}
if (-not $Version) {
  $Version = if ($env:NOMSOD_NODE_VERSION) { $env:NOMSOD_NODE_VERSION } else { "24.13.0" }
}

$arch = switch ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()) {
  "x64" { "x64" }
  "arm64" { "arm64" }
  default { throw "Unsupported Windows architecture." }
}

$runtimeDir = Join-Path $Root ".runtime"
$nodeDir = Join-Path $runtimeDir "node"
$nodeExe = Join-Path $nodeDir "node.exe"

if (Test-Path $nodeExe) {
  try {
    $current = (& $nodeExe --version).Trim().TrimStart("v")
    if ($current -eq $Version) {
      Write-Host "Portable Node already installed: v$Version"
      Write-Output $nodeExe
      exit 0
    }
  } catch {}
}

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
$temp = Join-Path $runtimeDir ("node-download-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $temp | Out-Null

try {
  $base = "https://nodejs.org/dist/v$Version"
  $archive = "node-v$Version-win-$arch.zip"
  $archivePath = Join-Path $temp $archive
  $sumPath = Join-Path $temp "SHASUMS256.txt"

  Write-Host "Downloading Node.js v$Version for win-$arch..."
  Invoke-WebRequest -UseBasicParsing -Uri "$base/$archive" -OutFile $archivePath
  Invoke-WebRequest -UseBasicParsing -Uri "$base/SHASUMS256.txt" -OutFile $sumPath

  $expectedLine = Get-Content $sumPath | Where-Object { $_ -match ("\s+" + [Regex]::Escape($archive) + "$") } | Select-Object -First 1
  if (-not $expectedLine) { throw "Checksum for $archive was not found." }
  $expected = ($expectedLine -split "\s+")[0].ToLowerInvariant()
  $actual = (Get-FileHash -Algorithm SHA256 -Path $archivePath).Hash.ToLowerInvariant()

  if ($expected -ne $actual) {
    throw "Node.js checksum verification failed. Expected $expected, got $actual"
  }

  $extractDir = Join-Path $temp "extract"
  Expand-Archive -LiteralPath $archivePath -DestinationPath $extractDir -Force
  $sourceDir = Join-Path $extractDir "node-v$Version-win-$arch"
  if (-not (Test-Path (Join-Path $sourceDir "node.exe"))) {
    throw "Downloaded Node.js archive did not contain node.exe."
  }

  $newDir = Join-Path $runtimeDir "node.new"
  Remove-Item $newDir -Recurse -Force -ErrorAction SilentlyContinue
  Move-Item -LiteralPath $sourceDir -Destination $newDir

  Remove-Item $nodeDir -Recurse -Force -ErrorAction SilentlyContinue
  Move-Item -LiteralPath $newDir -Destination $nodeDir

  Write-Host "Portable Node installed: $nodeExe"
  & $nodeExe --version
  Write-Output $nodeExe
} finally {
  Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
}
