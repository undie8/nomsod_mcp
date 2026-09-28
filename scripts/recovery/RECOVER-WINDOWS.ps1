$ErrorActionPreference = "Stop"

$bundleRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$bootstrap = Join-Path $bundleRoot "distribution\install\windows.ps1"

if (-not (Test-Path $bootstrap)) {
  throw "Recovery kit is incomplete: distribution\install\windows.ps1 is missing."
}

Write-Host "Nomsod MCP single-cluster recovery"
Write-Host "Restoring the existing cluster from this recovery kit..."
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $bootstrap -RecoveryBundleRoot $bundleRoot
if ($LASTEXITCODE -ne 0) {
  throw "Nomsod MCP recovery installation failed with exit code $LASTEXITCODE."
}
