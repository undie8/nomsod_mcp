param(
  [string]$RuntimeRoot = "",
  [string]$NasSshHost = "100.111.178.74",
  [string]$NasSshUser = "gunn",
  [string]$NasPath = "/volume1/docker/nomsod-bootstrap"
)

$ErrorActionPreference = "Stop"

if (-not $RuntimeRoot) { $RuntimeRoot = Join-Path $env:LOCALAPPDATA "Nomsod MCP" }
$RuntimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)
$repoExporter = Join-Path (Split-Path $PSScriptRoot -Parent) "recovery\export.ps1"
$exporter = if (Test-Path $repoExporter) { $repoExporter } else { Join-Path $RuntimeRoot "scripts\recovery\export.ps1" }
$versionFile = Join-Path $RuntimeRoot "VERSION"
if (-not (Test-Path $exporter)) { throw "Installed Nomsod recovery exporter is missing." }
if (-not (Test-Path $versionFile)) { throw "Installed Nomsod VERSION is missing." }

$version = ([IO.File]::ReadAllText($versionFile)).Trim()
$work = Join-Path $env:TEMP ("nomsod-nas-bootstrap-" + [guid]::NewGuid().ToString("N"))
$zip = Join-Path $work "bundle.zip"
$extract = Join-Path $work "extract"
$packageRoot = Join-Path $work "current"
$archive = Join-Path $work "nomsod-bootstrap-current.tar.gz"
$scriptRoot = [IO.Path]::GetFullPath($PSScriptRoot)

try {
  New-Item -ItemType Directory -Force -Path $work,$extract,$packageRoot | Out-Null
  & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $exporter -Root $RuntimeRoot -Destination $zip -Force | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not export the cluster bootstrap bundle." }

  Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force
  $bundleSource = Join-Path $extract "Nomsod-Recovery-Kit"
  if (-not (Test-Path $bundleSource)) { throw "Exported bootstrap bundle is incomplete." }

  foreach ($file in @("INSTALL-WINDOWS.cmd","INSTALL-WINDOWS.ps1","INSTALL-MACOS.command","INSTALL-MACOS.sh","README.txt")) {
    Copy-Item (Join-Path $scriptRoot $file) (Join-Path $packageRoot $file) -Force
  }
  Copy-Item $bundleSource (Join-Path $packageRoot "bundle") -Recurse -Force

  $recovery = [IO.File]::ReadAllText((Join-Path $bundleSource "recovery.json")) | ConvertFrom-Json
  $status = [ordered]@{
    kind = "nomsod-nas-bootstrap"
    authority = "KKSM2"
    nasHostname = "KKS"
    clusterId = [string]$recovery.clusterId
    version = if ([string]$recovery.distribution.windowsVersion -eq [string]$recovery.distribution.macosVersion) { [string]$recovery.distribution.windowsVersion } else { $version }
    windowsVersion = [string]$recovery.distribution.windowsVersion
    macosVersion = [string]$recovery.distribution.macosVersion
    updatedAt = [DateTime]::UtcNow.ToString("o")
  }
  [IO.File]::WriteAllText((Join-Path $packageRoot "STATUS.json"),($status | ConvertTo-Json -Depth 4),(New-Object Text.UTF8Encoding($false)))

  $tar = (Get-Command tar.exe -ErrorAction Stop).Source
  & $tar -czf $archive -C $packageRoot .
  if ($LASTEXITCODE -ne 0) { throw "Could not package NAS bootstrap authority." }

  $ssh = (Get-Command ssh.exe -ErrorAction Stop).Source
  $scp = (Get-Command scp.exe -ErrorAction Stop).Source
  $remote = "$NasSshUser@$NasSshHost"
  $remoteArchive = "$NasPath/.incoming.tar.gz"

  & $ssh -o BatchMode=yes -o ConnectTimeout=8 $remote "mkdir -p '$NasPath' && chmod 700 '$NasPath'"
  if ($LASTEXITCODE -ne 0) { throw "Could not prepare NAS bootstrap directory." }

  & $scp -O -q -o BatchMode=yes -o ConnectTimeout=8 $archive "${remote}:$remoteArchive"
  if ($LASTEXITCODE -ne 0) { throw "Could not upload NAS bootstrap authority." }

  $activate = "set -eu; rm -rf '$NasPath/current.new'; mkdir -p '$NasPath/current.new'; /usr/bin/tar -xzf '$remoteArchive' -C '$NasPath/current.new'; rm -f '$remoteArchive'; rm -rf '$NasPath/previous'; if [ -d '$NasPath/current' ]; then mv '$NasPath/current' '$NasPath/previous'; fi; mv '$NasPath/current.new' '$NasPath/current'; find '$NasPath/current' -type d -exec chmod 750 {} \;; find '$NasPath/current' -type f -exec chmod 640 {} \;; chmod 750 '$NasPath/current/INSTALL-MACOS.command' '$NasPath/current/INSTALL-MACOS.sh'; chmod 750 '$NasPath/current/bundle/RECOVER-MACOS.sh' 2>/dev/null || true; chmod 750 '$NasPath'"
  & $ssh -o BatchMode=yes -o ConnectTimeout=8 $remote $activate
  if ($LASTEXITCODE -ne 0) { throw "NAS bootstrap upload succeeded, but activation failed." }

  Write-Host "Nomsod NAS bootstrap authority updated."
  Write-Host "NAS: KKSM2 / KKS"
  Write-Host ("Cluster: {0}" -f $status.clusterId)
  Write-Host ("Version: {0}" -f $status.version)
  Write-Host "Windows SMB: \\KKS\docker\nomsod-bootstrap\current\INSTALL-WINDOWS.cmd"
  Write-Host "macOS SMB: smb://KKS/docker/nomsod-bootstrap/current"
} finally {
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
