param(
    [switch]$Screenshot,
    [switch]$Narrow,
    [switch]$PrepareSourceSnapshot,
    [string]$WowPath
)

$ErrorActionPreference = 'Stop'
$previewRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$previewVersion = '0.1.40'
$previewPackage = "wow-ui-sim-v$previewVersion-forever-windows-x86_64"
$previewTools = Join-Path $previewRoot "runtime/tooling/wow-ui-sim-$previewVersion-forever"
$previewExecutable = Join-Path $previewTools "$previewPackage/wow-sim.exe"
if (!(Test-Path -LiteralPath $previewExecutable)) {
    New-Item -ItemType Directory -Force -Path $previewTools | Out-Null
    $previewRelease = Invoke-RestMethod "https://api.github.com/repos/Osso/wow-ui-sim/releases/tags/v$previewVersion"
    $previewAsset = $previewRelease.assets | Where-Object { $_.name -eq "$previewPackage.zip" }
    if (!$previewAsset -or !$previewAsset.digest) { throw 'Release ZIP or SHA-256 digest is missing.' }
    $previewArchive = Join-Path $previewTools 'package.zip'
    Invoke-WebRequest -Uri $previewAsset.browser_download_url -OutFile $previewArchive
    $previewDigest = 'sha256:' + (Get-FileHash -LiteralPath $previewArchive -Algorithm SHA256).Hash.ToLower()
    if ($previewDigest -ne $previewAsset.digest) { throw 'Release SHA-256 mismatch.' }
    Expand-Archive -LiteralPath $previewArchive -DestinationPath $previewTools -Force
}

if (!$WowPath) {
    $previewConfig = Get-Content -LiteralPath (Join-Path $previewRoot 'config.local.json') -Raw | ConvertFrom-Json
    $WowPath = $previewConfig.wow
    if (!(Test-Path -LiteralPath (Join-Path $WowPath 'Data/data'))) {
        $WowPath = Split-Path -Parent $WowPath
    }
}
if (!(Test-Path -LiteralPath (Join-Path $WowPath 'Data/data'))) {
    throw 'Pass -WowPath with the WoW installation root containing Data/data.'
}

# Optional workaround for 0.1.40's 70707 source pin and missing local enUS
# files on 70862. This is an explicit source-snapshot cache, not a claim that
# the simulator successfully synchronized every file from local CASC.
if ($PrepareSourceSnapshot) {
    $previewRevision = '9dc84f0d3bbae1768ac3405b3716000bd93eda06'
    $previewBuildInfo = Get-Content -LiteralPath (Join-Path $WowPath '.build.info')
    if (!($previewBuildInfo | Where-Object { $_ -match '1\.60\.1\.70862' -and $_ -match 'wowf' })) {
        throw 'This source snapshot is only for Forever build 1.60.1.70862.'
    }
    $previewSnapshotDir = Join-Path $previewTools "wow-ui-source-$previewRevision"
    if (!(Test-Path -LiteralPath (Join-Path $previewSnapshotDir 'version.txt'))) {
        $previewSnapshotArchive = Join-Path $previewTools 'source-70862.tar.gz'
        Invoke-WebRequest "https://codeload.github.com/Gethe/wow-ui-source/tar.gz/$previewRevision" -OutFile $previewSnapshotArchive
        tar -xzf $previewSnapshotArchive -C $previewTools
        if ($LASTEXITCODE -ne 0) { throw 'Could not extract source snapshot.' }
    }
    if ((Get-Content -LiteralPath (Join-Path $previewSnapshotDir 'version.txt') -Raw).Trim() -ne '1.60.1.70862') {
        throw 'Source snapshot version mismatch.'
    }
    $previewSourceCache = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'wow-ui-sim/blizzard-ui/wowforever/AddOns'
    robocopy (Join-Path $previewSnapshotDir 'Interface/AddOns') $previewSourceCache /E /NFL /NDL /NJH /NJS /R:0 /W:0 | Out-Null
    if ($LASTEXITCODE -ge 8) { throw 'Could not copy source snapshot.' }
    Set-Content -LiteralPath (Join-Path $previewSourceCache '.wow-ui-sim-blizzard-ui-provenance') -Value "profile=WowForever`nproduct=wowf`nversion=1.60.1.70862`nsource=Gethe/wow-ui-source`nrevision=$previewRevision`nmode=manual-exact-build-source-snapshot-for-preview`n"
    Set-Content -LiteralPath (Join-Path $previewSourceCache '.wow-ui-sim-blizzard-ui-complete') -Value 'Complete exact-build source snapshot copied from Gethe; not a CASC synchronization result.'
}

$previewOutput = Join-Path $previewRoot 'artifacts/wow-ui-sim-preview'
$previewAddons = Join-Path $previewOutput 'AddOns'
$previewAddon = Join-Path $previewAddons 'WispAI'
New-Item -ItemType Directory -Path $previewAddon -Force | Out-Null
# Use the production UI modules with offline transport/game-state fixtures.
# Never load installed addons or write to the real game's WTF directory.
$previewFiles = @(
    'Core.lua', 'ChatHistory.lua', 'RichUI.lua', 'Widgets.lua',
    'EmojiData.lua', 'Emoji.lua', 'MessageFormat.lua', 'ModelControls.lua',
    'MessageRows.lua', 'UI.lua', 'Panels.lua'
)
foreach ($previewFile in $previewFiles) {
    Copy-Item -LiteralPath (Join-Path $previewRoot "addon/WispAI/$previewFile") -Destination (Join-Path $previewAddon $previewFile)
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'fixture.lua') -Destination (Join-Path $previewAddon 'fixture.lua')
Copy-Item -LiteralPath (Join-Path $previewRoot 'addon/WispAI/Textures') -Destination $previewAddon -Recurse -Force
Set-Content -LiteralPath (Join-Path $previewAddon 'WispAI.toc') -Encoding utf8 -Value (
    @('## Interface: 16001', '## Title: Wisp AI Offline Preview', '## SavedVariables: WispAIDB') + $previewFiles + @('fixture.lua')
)
$previewArgs = @(
    '--allow-ui-version-mismatch',
    '--addons-path', $previewAddons,
    '--session-wtf-path', (Join-Path $previewOutput 'WTF'),
    '--no-saved-vars', '--exec-lua', $(if ($Narrow) { 'WispDemoStage(9)' } else { 'WispDemoStage(8)' })
)
if ($Screenshot) {
    $previewImage = Join-Path $previewOutput $(if ($Narrow) { 'comparison-narrow.png' } else { 'comparison.png' })
    $previewArgs += @('screenshot', '--width', '1280', '--height', '840', '--png', '-o', $previewImage)
} else {
    $previewArgs += @('--window-size', '1280x840')
}
$previewOldInstall = $env:WOW_INSTALL_PATH
$previewOldSound = $env:WOW_SIM_NO_SOUND
try {
    $env:WOW_INSTALL_PATH = $WowPath
    $env:WOW_SIM_NO_SOUND = '1'
    & $previewExecutable @previewArgs
    if ($LASTEXITCODE -ne 0) { throw "wow-ui-sim exited with code $LASTEXITCODE" }
    if ($Screenshot) {
        if (!(Test-Path -LiteralPath $previewImage)) { throw 'Simulator did not produce the screenshot.' }
        Write-Output "Preview: $previewImage"
    }
} finally {
    $env:WOW_INSTALL_PATH = $previewOldInstall
    $env:WOW_SIM_NO_SOUND = $previewOldSound
}
