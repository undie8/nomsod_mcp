$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$taskCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $taskCompiler)) {
  $taskCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
$taskOutput = Join-Path ([IO.Path]::GetTempPath()) ('JobsMonitorSmoke-' + [Guid]::NewGuid().ToString('N') + '.exe')
try {
  & $taskCompiler /nologo /target:exe /main:JobsMonitorSmoke /reference:System.dll /reference:System.Core.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll "/out:$taskOutput" (Join-Path $taskRoot 'scripts\windows\NomsodMcpControl.cs') (Join-Path $PSScriptRoot 'JobsMonitorSmoke.cs')
  if ($LASTEXITCODE -ne 0) { throw 'Jobs Monitor test compilation failed.' }
  & $taskOutput
  if ($LASTEXITCODE -ne 0) { throw 'Jobs Monitor smoke test failed.' }
}
finally {
  if (Test-Path -LiteralPath $taskOutput) { Remove-Item -LiteralPath $taskOutput -Force }
}
