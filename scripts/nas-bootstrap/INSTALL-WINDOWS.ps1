$ErrorActionPreference = "Stop"

$authorityRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$bundleRoot = Join-Path $authorityRoot "bundle"
$bootstrap = Join-Path $bundleRoot "distribution\install\windows.ps1"
$statusFile = Join-Path $authorityRoot "STATUS.json"

if (-not (Test-Path $bootstrap)) {
  throw "Nomsod NAS bootstrap is incomplete: Windows installer is missing."
}

if (Test-Path $statusFile) {
  try {
    $status = [IO.File]::ReadAllText($statusFile) | ConvertFrom-Json
    Write-Host ("Nomsod MCP NAS bootstrap: cluster={0} version={1}" -f $status.clusterId, $status.version)
  } catch {}
}

Write-Host "Installing the existing Nomsod cluster from NAS..."
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $bootstrap -RecoveryBundleRoot $bundleRoot
if ($LASTEXITCODE -ne 0) {
  throw "Nomsod MCP installation failed with exit code $LASTEXITCODE."
}

Write-Host ""
Write-Host "Nomsod MCP installation from NAS completed."
