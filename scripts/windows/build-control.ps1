param(
  [string]$Root = ""
)

$ErrorActionPreference = "Stop"
if (-not $Root) {
  $Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
}

$Source = Join-Path $PSScriptRoot "NomsodMcpControl.cs"
$BackgroundSource = Join-Path $PSScriptRoot "NomsodMcpBackground.cs"
$OutDir = Join-Path $Root "build\windows"
$OutFile = Join-Path $OutDir "Nomsod MCP Control.exe"
$Version = ([IO.File]::ReadAllText((Join-Path $Root "VERSION"))).Trim()
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
  throw "Invalid VERSION value: $Version"
}
$BackgroundOutDir = Join-Path $OutDir ("background\" + $Version)
$BackgroundOutFile = Join-Path $BackgroundOutDir "Nomsod MCP Background.exe"
$TunnelOutFile = Join-Path $BackgroundOutDir "Nomsod MCP Tunnel.exe"
$IconFile = Join-Path $Root "assets\nomsod-mcp-transparent.ico"
New-Item -ItemType Directory -Force -Path $OutDir,$BackgroundOutDir | Out-Null

if (-not (Test-Path $IconFile)) {
  throw "Missing icon asset: $IconFile"
}

$candidates = @(
  "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
  "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)

$csc = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) { throw "C# compiler csc.exe was not found." }

$args = @(
  "/nologo",
  "/target:winexe",
  "/optimize+",
  "/reference:System.dll",
  "/reference:System.Core.dll",
  "/reference:System.Drawing.dll",
  "/reference:System.Windows.Forms.dll",
  "/win32icon:$IconFile",
  "/out:$OutFile",
  $Source
)

& $csc @args
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $OutFile)) {
  throw "Failed to build Nomsod MCP Control."
}

$backgroundArgs = @(
  "/nologo",
  "/target:winexe",
  "/optimize+",
  "/reference:System.dll",
  "/reference:System.Core.dll",
  "/win32icon:$IconFile",
  "/out:$BackgroundOutFile",
  $BackgroundSource
)

& $csc @backgroundArgs
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $BackgroundOutFile)) {
  throw "Failed to build Nomsod MCP Background."
}

Copy-Item -LiteralPath $BackgroundOutFile -Destination $TunnelOutFile -Force

Write-Host "Built: $OutFile"
Write-Host "Built: $BackgroundOutFile"
Write-Host "Built: $TunnelOutFile"
Write-Host "Icon: $IconFile"
