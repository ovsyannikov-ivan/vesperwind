[CmdletBinding()]
param(
    [string]$MsysRoot = 'C:\msys64',
    [string]$BuildRoot = (Join-Path $env:TEMP 'vesperwind-libmpv-windows'),
    [int]$Jobs = [Math]::Min(8, [Environment]::ProcessorCount)
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$resolvedBuild = [IO.Path]::GetFullPath($BuildRoot)
if ($resolvedBuild.Equals($projectRoot, [StringComparison]::OrdinalIgnoreCase) -or $resolvedBuild.StartsWith($projectRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'BuildRoot must be outside the repository.'
}
$bash = Join-Path $MsysRoot 'usr\bin\bash.exe'
if (!(Test-Path -LiteralPath $bash)) { throw "Install MSYS2 UCRT64 first; missing $bash" }
if ($Jobs -lt 1) { throw 'Jobs must be positive.' }
$saved = @{}
foreach ($name in @('MSYSTEM', 'CHERE_INVOKING', 'VESPERWIND_NODE', 'VESPERWIND_LIBMPV_BUILD_DIR', 'VESPERWIND_LIBMPV_PROJECT', 'VESPERWIND_LIBMPV_JOBS')) {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
try {
    New-Item -ItemType Directory -Force -Path $resolvedBuild | Out-Null
    # Bash reads scripts incrementally; execute a snapshot so edits made while a
    # long dependency build is running cannot change its remaining commands.
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'build-libmpv-windows.sh') -Destination (Join-Path $resolvedBuild 'build-libmpv-windows.sh')
    $env:MSYSTEM = 'UCRT64'
    $env:VESPERWIND_NODE = (Get-Command node.exe).Source
    $env:CHERE_INVOKING = '1'
    $env:VESPERWIND_LIBMPV_BUILD_DIR = $resolvedBuild
    $env:VESPERWIND_LIBMPV_PROJECT = $projectRoot
    $env:VESPERWIND_LIBMPV_JOBS = "$Jobs"
    & $bash -lc 'exec bash "$(cygpath -u "$VESPERWIND_LIBMPV_BUILD_DIR")/build-libmpv-windows.sh"'
    if ($LASTEXITCODE -ne 0) { throw "libmpv build failed ($LASTEXITCODE)" }
    & node (Join-Path $PSScriptRoot 'verify-libmpv-bundle.js') windows
    if ($LASTEXITCODE -ne 0) { throw 'Windows bundle verification failed.' }
} finally {
    foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
}
