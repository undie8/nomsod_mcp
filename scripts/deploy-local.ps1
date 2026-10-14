$ErrorActionPreference = 'Stop'
$target = Join-Path $env:LOCALAPPDATA 'Nomsod MCP'
Write-Output "Deploying to: $target"

Copy-Item -Path "dist\*" -Destination (Join-Path $target 'dist') -Recurse -Force
Copy-Item -Path "src\*" -Destination (Join-Path $target 'src') -Recurse -Force

Write-Output "Deployment successful!"
