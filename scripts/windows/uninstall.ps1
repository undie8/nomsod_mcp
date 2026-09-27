param(
  [ValidateSet("Both", "Supervisor", "Agent")]
  [string]$Mode = "Both"
)

$ErrorActionPreference = "SilentlyContinue"

$tasks = @()
if ($Mode -in @("Both", "Supervisor")) { $tasks += "NomsodMCP-Supervisor" }
if ($Mode -in @("Both", "Agent")) { $tasks += "NomsodMCP-Agent" }
if ($Mode -eq "Both" -or $Mode -eq "Supervisor") { $tasks += "NomsodMCP-Watchdog" }

foreach ($task in $tasks | Select-Object -Unique) {
  & schtasks.exe /End /TN $task 1>$null 2>$null
  & schtasks.exe /Delete /TN $task /F 1>$null 2>$null
  if ($LASTEXITCODE -eq 0) {
    Write-Host "Removed $task"
  }
}

Write-Host "Nomsod data, releases, .env and device identity were preserved."
