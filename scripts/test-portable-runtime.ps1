param(
  [string]$Executable = 'release/build/windows-x64/The-Melody-of-Oblivion-Remake-Windows-x64.exe',
  [ValidateSet('x64', 'ia32', 'arm64')][string]$ExpectedArch = 'x64'
)
$ErrorActionPreference = 'Stop'
$exePath = (Resolve-Path -LiteralPath $Executable).Path
$parent = Split-Path -Parent $exePath
$runtimeRoot = Join-Path $parent 'Melody/runtime'
$cachePrefix = @{ x64 = '64'; ia32 = '32'; arm64 = 'ARM64' }[$ExpectedArch]
$expectedVersion = (Get-Content -Raw (Join-Path $PSScriptRoot '../package.json') | ConvertFrom-Json).version

function Start-Smoke([string]$PathToExe) {
  $reportFile = [IO.Path]::GetTempFileName()
  $oldReport = $env:MELODY_SMOKE_RESULT
  try {
    $env:MELODY_SMOKE_RESULT = $reportFile
    $child = Start-Process -FilePath $PathToExe -ArgumentList '--smoke-test' -WindowStyle Hidden -PassThru
    $child | Add-Member -NotePropertyName ReportFile -NotePropertyValue $reportFile
    return $child
  } finally { $env:MELODY_SMOKE_RESULT = $oldReport }
}

function Wait-Smoke($SmokeProcess, [switch]$AllowForwarded) {
  if (-not $SmokeProcess.WaitForExit(60000)) {
    Stop-Process -Id $SmokeProcess.Id -Force
    throw 'Portable smoke test timed out'
  }
  $SmokeProcess.Refresh()
  if ($SmokeProcess.ExitCode -ne 0) { throw "Portable smoke test failed: $($SmokeProcess.ExitCode)" }
  try {
    $contents = Get-Content -Raw -LiteralPath $SmokeProcess.ReportFile
    if (-not $contents -and $AllowForwarded) { return }
    $report = $contents | ConvertFrom-Json
    if (-not $report.ok -or -not $report.packaged -or $report.arch -ne $ExpectedArch -or $report.version -ne $expectedVersion) {
      throw 'Portable smoke report does not match the target package'
    }
    $SmokeProcess | Add-Member -NotePropertyName HasReport -NotePropertyValue $true
  } finally { Remove-Item -LiteralPath $SmokeProcess.ReportFile -Force -ErrorAction SilentlyContinue }
}

$timer = [System.Diagnostics.Stopwatch]::StartNew()
Wait-Smoke (Start-Smoke $exePath)
$firstMs = $timer.ElapsedMilliseconds
$cache = Get-ChildItem -LiteralPath $runtimeRoot -Directory |
  Where-Object { $_.Name -match ('^' + $cachePrefix + '-[a-f0-9]{64}$') -and (Test-Path -LiteralPath (Join-Path $_.FullName '.complete')) } |
  Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
if (-not $cache) { throw 'Portable EXE did not create a complete runtime beside itself' }
$markerPath = Join-Path $cache.FullName '.complete'
$markerTime = (Get-Item -LiteralPath $markerPath).LastWriteTimeUtc
$timer.Restart()
Wait-Smoke (Start-Smoke $exePath)
$warmMs = $timer.ElapsedMilliseconds
if ((Get-Item -LiteralPath $markerPath).LastWriteTimeUtc -ne $markerTime) {
  throw 'Warm startup extracted the runtime again'
}
Write-Output "Adjacent runtime reuse passed: first=$firstMs ms, warm=$warmMs ms"

# Removing only the completion marker models an interrupted/incomplete extraction.
Move-Item -LiteralPath $markerPath -Destination ($markerPath + '.smoke-incomplete')
$first = Start-Smoke $exePath
$second = Start-Smoke $exePath
Wait-Smoke $first -AllowForwarded
Wait-Smoke $second -AllowForwarded
if (-not $first.HasReport -and -not $second.HasReport) { throw 'Concurrent startup produced no packaged smoke report' }
if (-not (Test-Path -LiteralPath $markerPath)) { throw 'Incomplete runtime was not repaired' }
if (-not (Get-ChildItem -LiteralPath $runtimeRoot -Directory |
  Where-Object Name -Like ($cache.Name + '.incomplete-*'))) {
  throw 'Repair overwrote the incomplete runtime instead of preserving it'
}
Write-Output 'Concurrent startup and incomplete-runtime repair passed'

# A file blocking the adjacent runtime directory models an unwritable destination,
# without changing any system or user directory permissions.
$fallbackTest = Join-Path $parent 'portable-fallback-smoke'
New-Item -ItemType Directory -Path $fallbackTest -Force | Out-Null
$fallbackExe = Join-Path $fallbackTest 'launcher.exe'
Copy-Item -LiteralPath $exePath -Destination $fallbackExe -Force
$blockedRoot = Join-Path $fallbackTest 'Melody'
if (Test-Path -LiteralPath $blockedRoot -PathType Container) { throw 'Fallback fixture already contains a runtime directory' }
Set-Content -LiteralPath $blockedRoot -Value 'Blocked directory for smoke test'
Wait-Smoke (Start-Smoke $fallbackExe)
$fallbackMarker = Join-Path $env:LOCALAPPDATA ('MelodyOfOblivion/runtime/' + $cache.Name + '/.complete')
if (-not (Test-Path -LiteralPath $fallbackMarker)) { throw 'User-cache fallback failed' }
$fallbackTime = (Get-Item -LiteralPath $fallbackMarker).LastWriteTimeUtc
Wait-Smoke (Start-Smoke $fallbackExe)
if ((Get-Item -LiteralPath $fallbackMarker).LastWriteTimeUtc -ne $fallbackTime) { throw 'Fallback runtime was not reused' }
Write-Output 'User-cache fallback and reuse passed'

$report = @{ firstRunMs = $firstMs; warmRunMs = $warmMs; runtime = $cache.FullName;
  reuse = $true; concurrentRepair = $true; fallbackReuse = $true }
$report | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $parent 'portable-runtime-smoke.json') -Encoding UTF8
