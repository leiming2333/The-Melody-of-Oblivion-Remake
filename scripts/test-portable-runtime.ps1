param([string]$Executable = 'release/The-Melody-of-Oblivion-Remake-Windows-x64.exe')
$ErrorActionPreference = 'Stop'
$exePath = (Resolve-Path -LiteralPath $Executable).Path
$parent = Split-Path -Parent $exePath
$runtimeRoot = Join-Path $parent 'Melody/runtime'

function Start-Smoke([string]$PathToExe) {
  Start-Process -FilePath $PathToExe -ArgumentList '--smoke-test' -WindowStyle Hidden -PassThru
}

function Wait-Smoke($SmokeProcess) {
  if (-not $SmokeProcess.WaitForExit(60000)) {
    Stop-Process -Id $SmokeProcess.Id -Force
    throw 'Portable smoke test timed out'
  }
  $SmokeProcess.Refresh()
  if ($SmokeProcess.ExitCode -ne 0) { throw "Portable smoke test failed: $($SmokeProcess.ExitCode)" }
}

$timer = [System.Diagnostics.Stopwatch]::StartNew()
Wait-Smoke (Start-Smoke $exePath)
$firstMs = $timer.ElapsedMilliseconds
$cache = Get-ChildItem -LiteralPath $runtimeRoot -Directory |
  Where-Object { $_.Name -match '^64-[a-f0-9]{64}$' -and (Test-Path -LiteralPath (Join-Path $_.FullName '.complete')) } |
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
Wait-Smoke $first
Wait-Smoke $second
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
