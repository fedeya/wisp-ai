$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$pidPath = Join-Path $projectRoot 'runtime\bridge.pid'
if (-not (Test-Path -LiteralPath $pidPath)) { Write-Output 'Wisp is not running.'; exit 0 }
$bridgeProcessId = [int](Get-Content -LiteralPath $pidPath -Raw).Trim()
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$bridgeProcessId" -ErrorAction SilentlyContinue
$entryPath = Join-Path $projectRoot 'apps\server\src\main.ts'
if (-not $process -or $process.CommandLine -notlike ('*' + $entryPath + '*')) { Write-Output 'Wisp is not running.'; exit 0 }
& taskkill.exe /PID $bridgeProcessId /T /F | Out-Null
Write-Output 'Wisp stopped.'
