param(
  [string]$RuntimeRoot = "",
  [string]$NasSshHost = "100.111.178.74",
  [string]$NasSshUser = "gunn",
  [string]$NasPath = "/volume1/docker/nomsod-bootstrap",
  [string]$PublicBaseUrl = "https://install.nomsod.net"
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
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
$work = [IO.Path]::GetFullPath((Join-Path $tempRoot ("nomsod-nas-bootstrap-" + [guid]::NewGuid().ToString("N"))))
if ([IO.Path]::GetDirectoryName($work) -ne $tempRoot -or
    -not ([IO.Path]::GetFileName($work)).StartsWith("nomsod-nas-bootstrap-")) {
  throw "Unsafe NAS bootstrap temporary directory."
}
$zip = Join-Path $work "bundle.zip"
$extract = Join-Path $work "extract"
$packageRoot = Join-Path $work "current"
$archive = Join-Path $work "nomsod-bootstrap-current.tar.gz"
$scriptRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$utf8 = New-Object Text.UTF8Encoding($false)

$ssh = (Get-Command ssh.exe -ErrorAction Stop).Source
$scp = (Get-Command scp.exe -ErrorAction Stop).Source
$remote = "$NasSshUser@$NasSshHost"

try {
  New-Item -ItemType Directory -Force -Path $work,$extract,$packageRoot | Out-Null

  $tokenCommand = "set -eu; mkdir -p '$NasPath'; chmod 750 '$NasPath'; if [ ! -s '$NasPath/bootstrap-token' ]; then python3 -c 'import secrets; print(secrets.token_urlsafe(32))' > '$NasPath/bootstrap-token'; chmod 600 '$NasPath/bootstrap-token'; fi; cat '$NasPath/bootstrap-token'"
  $tokenOutput = & $ssh -o BatchMode=yes -o ConnectTimeout=8 $remote $tokenCommand
  if ($LASTEXITCODE -ne 0) { throw "Could not read or create NAS bootstrap token." }
  $bootstrapToken = ([string]($tokenOutput | Select-Object -Last 1)).Trim()
  if ($bootstrapToken -notmatch '^[A-Za-z0-9_-]{32,128}$') { throw "NAS bootstrap token is invalid." }

  & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $exporter -Root $RuntimeRoot -Destination $zip -Force | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not export the cluster bootstrap bundle." }

  Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force
  $bundleSource = Join-Path $extract "Nomsod-Recovery-Kit"
  if (-not (Test-Path $bundleSource)) { throw "Exported bootstrap bundle is incomplete." }

  foreach ($file in @("INSTALL-WINDOWS.cmd","INSTALL-WINDOWS.ps1","INSTALL-MACOS.command","INSTALL-MACOS.sh","README.txt")) {
    Copy-Item (Join-Path $scriptRoot $file) (Join-Path $packageRoot $file) -Force
  }
  Copy-Item $bundleSource (Join-Path $packageRoot "bundle") -Recurse -Force

  $runtimeConfig = Join-Path $packageRoot "runtime-config"
  New-Item -ItemType Directory -Force -Path $runtimeConfig | Out-Null
  foreach ($file in @("nginx.conf","cloudflared.yml.template","provision-edge.sh")) {
    Copy-Item (Join-Path $scriptRoot $file) (Join-Path $runtimeConfig $file) -Force
  }

  $baseUrl = $PublicBaseUrl.TrimEnd("/") + "/bootstrap/" + $bootstrapToken
  $publicDir = Join-Path $packageRoot ("public\bootstrap\" + $bootstrapToken)
  New-Item -ItemType Directory -Force -Path $publicDir | Out-Null
  $winTemplate = [IO.File]::ReadAllText((Join-Path $scriptRoot "PUBLIC-WINDOWS.ps1.template"))
  $macTemplate = [IO.File]::ReadAllText((Join-Path $scriptRoot "PUBLIC-MACOS.sh.template"))
  $winScript = $winTemplate.Replace("__BASE_URL__", $baseUrl).Replace("__SELF_URL__", $baseUrl + "/windows.ps1")
  $macScript = $macTemplate.Replace("__BASE_URL__", $baseUrl)
  [IO.File]::WriteAllText((Join-Path $publicDir "windows.ps1"), $winScript, $utf8)
  [IO.File]::WriteAllText((Join-Path $publicDir "macos.sh"), $macScript, $utf8)
  $publicBundleZip = Join-Path $publicDir "bundle.zip"
  $tar = (Get-Command tar.exe -ErrorAction Stop).Source
  & $tar -a -cf $publicBundleZip -C $bundleSource .
  if ($LASTEXITCODE -ne 0) { throw "Could not create cross-platform public bootstrap bundle." }
  [IO.File]::WriteAllText((Join-Path $publicDir "windows-command.txt"), ("irm " + $baseUrl + "/windows.ps1 | iex" + [Environment]::NewLine), $utf8)
  [IO.File]::WriteAllText((Join-Path $publicDir "macos-command.txt"), ("curl -fsSL " + $baseUrl + "/macos.sh | sh" + [Environment]::NewLine), $utf8)

  $recovery = [IO.File]::ReadAllText((Join-Path $bundleSource "recovery.json")) | ConvertFrom-Json
  $status = [ordered]@{
    kind = "nomsod-nas-bootstrap"
    authority = "KKSM2"
    nasHostname = "KKS"
    clusterId = [string]$recovery.clusterId
    version = if ([string]$recovery.distribution.windowsVersion -eq [string]$recovery.distribution.macosVersion) { [string]$recovery.distribution.windowsVersion } else { $version }
    windowsVersion = [string]$recovery.distribution.windowsVersion
    macosVersion = [string]$recovery.distribution.macosVersion
    installHost = "install.nomsod.net"
    publicBootstrap = $true
    updatedAt = [DateTime]::UtcNow.ToString("o")
  }
  [IO.File]::WriteAllText((Join-Path $packageRoot "STATUS.json"),($status | ConvertTo-Json -Depth 4),$utf8)

  $tar = (Get-Command tar.exe -ErrorAction Stop).Source
  & $tar -czf $archive -C $packageRoot .
  if ($LASTEXITCODE -ne 0) { throw "Could not package NAS bootstrap authority." }

  $remoteArchive = "$NasPath/.incoming.tar.gz"
  & $scp -O -q -o BatchMode=yes -o ConnectTimeout=8 $archive "${remote}:$remoteArchive"
  if ($LASTEXITCODE -ne 0) { throw "Could not upload NAS bootstrap authority." }

  $activate = "set -eu; rm -rf '$NasPath/current.new'; mkdir -p '$NasPath/current.new'; /usr/bin/tar -xzf '$remoteArchive' -C '$NasPath/current.new'; rm -f '$remoteArchive'; rm -rf '$NasPath/previous'; if [ -d '$NasPath/current' ]; then mv '$NasPath/current' '$NasPath/previous'; fi; mv '$NasPath/current.new' '$NasPath/current'; find '$NasPath/current' -type d -exec chmod 750 {} \;; find '$NasPath/current' -type f -exec chmod 640 {} \;; chmod 750 '$NasPath/current/INSTALL-MACOS.command' '$NasPath/current/INSTALL-MACOS.sh' '$NasPath/current/runtime-config/provision-edge.sh'; chmod 750 '$NasPath/current/bundle/RECOVER-MACOS.sh' 2>/dev/null || true; chmod 750 '$NasPath'"
  & $ssh -o BatchMode=yes -o ConnectTimeout=8 $remote $activate
  if ($LASTEXITCODE -ne 0) { throw "NAS bootstrap upload succeeded, but activation failed." }

  & $ssh -o BatchMode=yes -o ConnectTimeout=8 $remote "sh '$NasPath/current/runtime-config/provision-edge.sh' '$NasPath' '100.111.178.74'"
  if ($LASTEXITCODE -ne 0) { throw "NAS bootstrap authority was updated, but public edge provisioning failed." }

  Write-Host "Nomsod NAS bootstrap authority updated."
  Write-Host "NAS: KKSM2 / KKS"
  Write-Host ("Cluster: {0}" -f $status.clusterId)
  Write-Host ("Version: {0}" -f $status.version)
  Write-Host "Windows SMB: \\KKS\docker\nomsod-bootstrap\current\INSTALL-WINDOWS.cmd"
  Write-Host "macOS SMB: smb://KKS/docker/nomsod-bootstrap/current"
  Write-Host "Public PowerShell bootstrap: ready at install.nomsod.net"
} finally {
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
