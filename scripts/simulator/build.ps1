param([string]$GoPath = 'go', [string]$ProtocPath = 'protoc')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$source = Join-Path $root 'node_modules\.cache\wowsims-levelsim'
$commit = '7f9c0e733fe3f8823407566dd417aca11f833e6f'
if (-not (Test-Path -LiteralPath (Join-Path $source '.git'))) {
    git clone --depth 1 --branch levelsim https://github.com/StewBagger/forever-levelsim.git $source
    if ($LASTEXITCODE -ne 0) { throw 'Could not fetch WoWSims levelsim.' }
}
$head = git -C $source rev-parse HEAD
if ($head -ne $commit) {
    git -C $source fetch --depth 1 origin $commit
    if ($LASTEXITCODE -ne 0) { throw 'Could not fetch the pinned simulator revision.' }
    git -C $source checkout --detach $commit
    if ($LASTEXITCODE -ne 0) { throw 'Could not select the pinned simulator revision.' }
}
$rankPatch = Join-Path $PSScriptRoot 'downranking.patch'
git -C $source apply --reverse --check $rankPatch 2>$null
if ($LASTEXITCODE -ne 0) {
    git -C $source apply --check $rankPatch
    if ($LASTEXITCODE -ne 0) { throw 'Simulator rank patch does not match the pinned source.' }
    git -C $source apply $rankPatch
    if ($LASTEXITCODE -ne 0) { throw 'Could not apply simulator rank patch.' }
}
$oldBin = $env:GOBIN
try {
    $env:GOBIN = Join-Path $source 'bin'
    New-Item -ItemType Directory -Path $env:GOBIN -Force | Out-Null
    & $GoPath install google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.10
    if ($LASTEXITCODE -ne 0) { throw 'Could not build protoc-gen-go.' }
    $files = Get-ChildItem -LiteralPath (Join-Path $source 'proto') -Filter '*.proto' | ForEach-Object FullName
    & $ProtocPath ('--plugin=protoc-gen-go=' + (Join-Path $env:GOBIN 'protoc-gen-go.exe')) ('-I=' + (Join-Path $source 'proto')) '--go_opt=Mgoogle/protobuf/descriptor.proto=google.golang.org/protobuf/types/descriptorpb' ('--go_out=' + (Join-Path $source 'sim\core')) @files
    if ($LASTEXITCODE -ne 0) { throw 'Could not generate simulator protocol types.' }
    New-Item -ItemType Directory -Path (Join-Path $root 'simulator') -Force | Out-Null
    Push-Location $source
    try {
        & $GoPath build --tags=with_db -o (Join-Path $root 'simulator\wowsimcli.exe') ./cmd/wowsimcli
        if ($LASTEXITCODE -ne 0) { throw 'Could not build WoWSims.' }
    } finally { Pop-Location }
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    $nodePath = if ($node) { $node.Source } else { Join-Path $root 'runtime\node.exe' }
    & $nodePath (Join-Path $PSScriptRoot 'metadata.ts') $source
    if ($LASTEXITCODE -ne 0) { throw 'Could not refresh simulator metadata.' }
} finally { $env:GOBIN = $oldBin }
