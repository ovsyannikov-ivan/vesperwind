# Use System.Diagnostics.Process directly. Redirected Start-Process on Windows
# PowerShell can return a null ExitCode despite a completed native corpus.
param([Parameter(Mandatory=$true)][string]$Output, [string]$Binary="")
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot
if (!$Binary) { $Binary = Join-Path $root "src-tauri/target/debug/vesperwind.exe" }
$Binary = (Resolve-Path $Binary).Path
if (Test-Path $Output) { throw "Use a new native regression output directory" }
New-Item -ItemType Directory $Output | Out-Null
$Output = (Resolve-Path $Output).Path
$info = [Diagnostics.ProcessStartInfo]::new()
$info.FileName = $Binary
$info.Arguments = '--native-regression "' + $Output.Replace('"', '') + '"'
$info.WorkingDirectory = $root
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$process = [Diagnostics.Process]::new()
$process.StartInfo = $info
$clock = [Diagnostics.Stopwatch]::StartNew()
if (!$process.Start()) { throw "Native process did not start" }
# Capture async reads and the live handle BEFORE waiting. Both pipes are drained.
$handle = $process.Handle
$stdout = $process.StandardOutput.ReadToEndAsync()
$stderr = $process.StandardError.ReadToEndAsync()
$timedOut = !$process.WaitForExit(240000)
if ($timedOut) { $process.Kill(); $process.WaitForExit() }
$exitCode = [int]$process.ExitCode
[IO.File]::WriteAllText((Join-Path $Output "native.log"), $stdout.Result + $stderr.Result, [Text.UTF8Encoding]::new($false))
$receipt = @{ code=$exitCode; timedOut=$timedOut; wallMs=$clock.Elapsed.TotalMilliseconds; runner="System.Diagnostics.Process"; exitCodeAvailable=$true; processHandleCached=($handle -ne [IntPtr]::Zero) }
[IO.File]::WriteAllText((Join-Path $Output "receipt.json"), ($receipt | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
$process.Dispose()
if ($timedOut -or $exitCode -ne 0) { throw "Native regression failed: $exitCode, timedOut=$timedOut" }
$events = Get-Content -Raw (Join-Path $Output "events.json") | ConvertFrom-Json
if ($events[-1].phase -ne "finished") { throw "Native conversion did not finish" }
node --input-type=module -e "import {validateNativeOutputs} from './scripts/validate-native-office.mjs'; console.log(await validateNativeOutputs(process.argv[1]))" $Output
if ($LASTEXITCODE -ne 0) { throw "Office readback validation failed" }
