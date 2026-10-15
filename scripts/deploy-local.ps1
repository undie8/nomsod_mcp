$ErrorActionPreference = 'Stop'
$target = Join-Path $env:LOCALAPPDATA 'Nomsod MCP'
Write-Output "Deploying to: $target"

Copy-Item -Path "dist\*" -Destination (Join-Path $target 'dist') -Recurse -Force
Copy-Item -Path "src\*" -Destination (Join-Path $target 'src') -Recurse -Force
Copy-Item -Path "VERSION" -Destination (Join-Path $target 'VERSION') -Force
Copy-Item -Path "package.json" -Destination (Join-Path $target 'package.json') -Force
if (Test-Path "build\windows\NomsodDesktopWin.exe") {
    Copy-Item -Path "build\windows\NomsodDesktopWin.exe" -Destination (Join-Path $target 'NomsodDesktopWin.exe') -Force
}
New-Item -ItemType Directory -Force -Path (Join-Path $target 'scripts\windows') | Out-Null
Copy-Item -Path "scripts\windows\NomsodDesktopWin.cs" -Destination (Join-Path $target 'scripts\windows\NomsodDesktopWin.cs') -Force

Write-Output "Deployment successful!"
