param(
  [string]$Root = "",
  [string]$PublicBaseUrl = "https://mcp.nomsod.net"
)

$ErrorActionPreference = "Stop"

if (-not $Root) {
  $Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
}

$version = ([IO.File]::ReadAllText((Join-Path $Root "VERSION"))).Trim()
if ($version -notmatch '^\d+\.\d+\.\d+$') {
  throw "VERSION must contain a semantic version such as 0.2.0"
}

Set-Location $Root

Write-Host "Validating Nomsod MCP v$version..."
npm install
if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
npm run typecheck
if ($LASTEXITCODE -ne 0) { throw "typecheck failed" }
npm test
if ($LASTEXITCODE -ne 0) { throw "tests failed" }
npm run build
if ($LASTEXITCODE -ne 0) { throw "build failed" }

$distribution = Join-Path $Root "data\distribution"
$releaseDir = Join-Path $distribution ("releases\" + $version)
$latestDir = Join-Path $distribution "releases\latest"
$installDir = Join-Path $distribution "install"

New-Item -ItemType Directory -Force -Path $releaseDir,$latestDir,$installDir | Out-Null

Copy-Item (Join-Path $Root "scripts\bootstrap\windows.ps1") (Join-Path $installDir "windows.ps1") -Force
Copy-Item (Join-Path $Root "scripts\bootstrap\macos.sh") (Join-Path $installDir "macos.sh") -Force

$stageRoot = Join-Path $Root "data\release-build"
Remove-Item $stageRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stageRoot | Out-Null

function Copy-SharedFiles([string]$stage) {
  New-Item -ItemType Directory -Force -Path $stage | Out-Null

  foreach($name in @(
    "VERSION",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tsconfig.build.json",
    ".editorconfig",
    ".gitattributes",
    ".env.example",
    "README.md"
  )) {
    $source = Join-Path $Root $name
    if(Test-Path $source){ Copy-Item $source (Join-Path $stage $name) -Force }
  }

  Copy-Item (Join-Path $Root "src") (Join-Path $stage "src") -Recurse -Force
  Copy-Item (Join-Path $Root "assets") (Join-Path $stage "assets") -Recurse -Force
  New-Item -ItemType Directory -Force -Path (Join-Path $stage "scripts") | Out-Null
}

$windowsStage = Join-Path $stageRoot "windows"
Copy-SharedFiles $windowsStage
Copy-Item (Join-Path $Root "scripts\windows") (Join-Path $windowsStage "scripts\windows") -Recurse -Force
New-Item -ItemType Directory -Force -Path (Join-Path $windowsStage "scripts\bootstrap") | Out-Null
Copy-Item (Join-Path $Root "scripts\bootstrap\windows.ps1") (Join-Path $windowsStage "scripts\bootstrap\windows.ps1") -Force

$macStage = Join-Path $stageRoot "macos"
Copy-SharedFiles $macStage
Copy-Item (Join-Path $Root "scripts\macos") (Join-Path $macStage "scripts\macos") -Recurse -Force
New-Item -ItemType Directory -Force -Path (Join-Path $macStage "scripts\bootstrap") | Out-Null
Copy-Item (Join-Path $Root "scripts\bootstrap\macos.sh") (Join-Path $macStage "scripts\bootstrap\macos.sh") -Force

$windowsArchive = Join-Path $releaseDir ("nomsod-mcp-windows-" + $version + ".zip")
$macArchive = Join-Path $releaseDir ("nomsod-mcp-macos-" + $version + ".tar.gz")
Remove-Item $windowsArchive,$macArchive -Force -ErrorAction SilentlyContinue

Compress-Archive -Path (Join-Path $windowsStage "*") -DestinationPath $windowsArchive -CompressionLevel Optimal

& tar.exe -czf $macArchive -C $macStage .
if ($LASTEXITCODE -ne 0) { throw "macOS release archive failed" }

$windowsSha = (Get-FileHash -Algorithm SHA256 -Path $windowsArchive).Hash.ToLowerInvariant()
$macSha = (Get-FileHash -Algorithm SHA256 -Path $macArchive).Hash.ToLowerInvariant()
$publishedAt = [DateTime]::UtcNow.ToString("o")
$base = $PublicBaseUrl.TrimEnd("/")

$windowsManifest = [ordered]@{
  version = $version
  platform = "windows"
  publishedAt = $publishedAt
  url = "$base/releases/$version/nomsod-mcp-windows-$version.zip"
  sha256 = $windowsSha
  bytes = (Get-Item $windowsArchive).Length
  installer = "$base/install/windows.ps1"
  checkIntervalSeconds = 60
}

$macManifest = [ordered]@{
  version = $version
  platform = "macos"
  publishedAt = $publishedAt
  url = "$base/releases/$version/nomsod-mcp-macos-$version.tar.gz"
  sha256 = $macSha
  bytes = (Get-Item $macArchive).Length
  installer = "$base/install/macos.sh"
  checkIntervalSeconds = 60
}

$utf8 = New-Object Text.UTF8Encoding($false)
$windowsJson = $windowsManifest | ConvertTo-Json -Depth 5
$macJson = $macManifest | ConvertTo-Json -Depth 5

[IO.File]::WriteAllText((Join-Path $releaseDir "windows.json"), $windowsJson + [Environment]::NewLine, $utf8)
[IO.File]::WriteAllText((Join-Path $releaseDir "macos.json"), $macJson + [Environment]::NewLine, $utf8)
[IO.File]::WriteAllText((Join-Path $latestDir "windows.json"), $windowsJson + [Environment]::NewLine, $utf8)
[IO.File]::WriteAllText((Join-Path $latestDir "macos.json"), $macJson + [Environment]::NewLine, $utf8)

Write-Host ""
Write-Host "Nomsod MCP v$version release built."
Write-Host "Windows: $windowsArchive"
Write-Host "  SHA256: $windowsSha"
Write-Host "macOS:   $macArchive"
Write-Host "  SHA256: $macSha"
Write-Host "Distribution: $distribution"
