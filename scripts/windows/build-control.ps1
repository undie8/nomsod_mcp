param(
  [string]$Root = ""
)

$ErrorActionPreference = "Stop"
if (-not $Root) {
  $Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
}

$Source = Join-Path $PSScriptRoot "NomsodMcpControl.cs"
$OutDir = Join-Path $Root "build\windows"
$OutFile = Join-Path $OutDir "Nomsod MCP Control.exe"
$IconFile = Join-Path $Root "assets\nomsod-mcp-transparent.ico"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

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

Write-Host "Built: $OutFile"
Write-Host "Icon: $IconFile"
