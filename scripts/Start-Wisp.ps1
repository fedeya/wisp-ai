$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$entryPath = Join-Path $projectRoot 'apps\server\src\main.ts'
$runtimePath = Join-Path $projectRoot 'runtime'
New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null
$pidPath = Join-Path $runtimePath 'bridge.pid'
if (Test-Path -LiteralPath $pidPath) {
    $bridgeProcessId = [int](Get-Content -LiteralPath $pidPath -Raw).Trim()
    $existing = Get-CimInstance Win32_Process -Filter "ProcessId=$bridgeProcessId" -ErrorAction SilentlyContinue
    if ($existing -and $existing.CommandLine -like ('*' + $entryPath + '*')) { Write-Output 'Wisp is already running.'; exit 0 }
}
$bundledNode = Join-Path $runtimePath 'node.exe'
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $bundledNode) { $nodePath = $bundledNode } elseif ($nodeCommand) { $nodePath = $nodeCommand.Source } else { $nodePath = (Get-Content -LiteralPath (Join-Path $projectRoot 'runtime-node.txt') -Raw).Trim() }
if (-not (Test-Path -LiteralPath $nodePath)) { throw 'Node 24+ was not found. Install Node and run scripts/install.ts again.' }
$env:Path = (Split-Path -Parent $nodePath) + ';' + $env:Path
Start-Process -FilePath $nodePath -ArgumentList ('"' + $entryPath + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimePath 'bridge.log') -RedirectStandardError (Join-Path $runtimePath 'bridge-error.log') | Out-Null
Write-Output 'Wisp is starting. Type /wisp in WoW.'
