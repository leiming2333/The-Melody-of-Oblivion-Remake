param(
  [Parameter(Mandatory)][string]$ArtifactDirectory,
  [Parameter(Mandatory)][ValidateSet('x64', 'ia32', 'arm64')][string]$ExpectedArch,
  [string]$ReportDirectory = 'package-diagnostics',
  [ValidateRange(5, 300)][int]$TimeoutSeconds = 180
)

$ErrorActionPreference = 'Stop'
$reportRoot = [IO.Path]::GetFullPath($ReportDirectory)
New-Item -ItemType Directory -Path $reportRoot -Force | Out-Null
$observationsPath = Join-Path $reportRoot 'observations.jsonl'
$resultFile = Join-Path $reportRoot ('smoke-result-' + [Guid]::NewGuid().ToString('N') + '.json')
$chromiumLog = Join-Path $reportRoot 'chromium.log'
$startedAt = [DateTime]::UtcNow
$knownProcessIds = [Collections.Generic.HashSet[int]]::new()
$knownProcessStarts = @{}
$knownPluginDirectories = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$initialPluginDirectories = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($entry in @(Get-ChildItem -LiteralPath ([IO.Path]::GetTempPath()) -Directory -Filter 'ns*.tmp' -ErrorAction SilentlyContinue)) {
  [void]$initialPluginDirectories.Add($entry.FullName)
}
$diagnosticExitCode = 1
$wrapper = $null
$runtimeRoots = @()
$summary = [ordered]@{ startedAt = $startedAt.ToString('o'); expectedArch = $ExpectedArch; timeoutSeconds = $TimeoutSeconds }

function Write-ReportJson([string]$Name, $Value) {
  ConvertTo-Json -InputObject $Value -Depth 12 | Set-Content -LiteralPath (Join-Path $reportRoot $Name) -Encoding utf8
}

# Capture only the launched package's windows, including a hidden NSIS error dialog.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class MelodyDiagnosticWindows {
  public delegate bool Callback(IntPtr window, IntPtr state);
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback, IntPtr state);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, Callback callback, IntPtr state);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  static string ReadText(IntPtr window) { var text = new StringBuilder(2048); GetWindowText(window, text, text.Capacity); return text.ToString(); }
  public static List<object> Capture(int[] processIds) {
    var allowed = new HashSet<int>(processIds); var result = new List<object>();
    EnumWindows((window, state) => {
      uint pid; GetWindowThreadProcessId(window, out pid); if (!allowed.Contains((int)pid)) return true;
      var children = new List<string>();
      EnumChildWindows(window, (child, unused) => { var text = ReadText(child); if (text.Length > 0 && children.Count < 100) children.Add(text); return true; }, IntPtr.Zero);
      var className = new StringBuilder(256); GetClassName(window, className, className.Capacity);
      result.Add(new { processId = pid, handle = window.ToInt64(), title = ReadText(window), className = className.ToString(), visible = IsWindowVisible(window), childTexts = children });
      return true;
    }, IntPtr.Zero);
    return result;
  }
}
'@

function Get-PackageObservation {
  $allProcesses = @(Get-CimInstance Win32_Process)
  $currentProcesses = @{}
  foreach ($item in $allProcesses) { $currentProcesses[[int]$item.ProcessId] = $item }
  # PIDs can be reused. Discover descendants only while the parent is the
  # same live process, and retain each child's creation time for later checks.
  do {
    $changed = $false
    foreach ($item in $allProcesses) {
      $parentId = [int]$item.ParentProcessId
      if (-not $knownProcessIds.Contains($parentId) -or -not $currentProcesses.ContainsKey($parentId)) { continue }
      $parent = $currentProcesses[$parentId]
      if (-not (Test-ProcessIdentity $parentId $parent.CreationDate)) { continue }
      if ($null -eq $item.CreationDate) { continue }
      if ($item.CreationDate.ToUniversalTime() -lt $knownProcessStarts[$parentId]) { continue }
      if ($knownProcessIds.Add([int]$item.ProcessId)) {
        $knownProcessStarts[[int]$item.ProcessId] = $item.CreationDate.ToUniversalTime()
        $changed = $true
      }
    }
  } while ($changed)
  $processes = @($allProcesses | Where-Object { Test-ProcessIdentity ([int]$_.ProcessId) $_.CreationDate } |
    Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine, CreationDate)
  $runtime = @()
  foreach ($root in $runtimeRoots) {
    if (Test-Path -LiteralPath $root -PathType Container) {
      foreach ($entry in @(Get-ChildItem -LiteralPath $root -Directory)) {
        $marker = Join-Path $entry.FullName '.complete'
        $runtime += [ordered]@{ path = $entry.FullName; complete = (Test-Path -LiteralPath $marker);
          fileCount = @(Get-ChildItem -LiteralPath $entry.FullName -File -Recurse -ErrorAction SilentlyContinue).Count;
          modifiedAt = $entry.LastWriteTimeUtc.ToString('o') }
      }
    }
  }
  $plugins = @()
  # NSIS decompresses in its new ns*.tmp/7z-out directory before copying to
  # the persistent cache. A zero-file directory exposes a decoder failure.
  foreach ($entry in @(Get-ChildItem -LiteralPath ([IO.Path]::GetTempPath()) -Directory -Filter 'ns*.tmp' -ErrorAction SilentlyContinue)) {
    if ($initialPluginDirectories.Contains($entry.FullName) -or $entry.CreationTimeUtc -lt $startedAt) { continue }
    [void]$knownPluginDirectories.Add($entry.FullName)
    $extracted = Join-Path $entry.FullName '7z-out'
    $extractedFiles = @(Get-ChildItem -LiteralPath $extracted -File -Recurse -ErrorAction SilentlyContinue)
    $plugins += [ordered]@{ path = $entry.FullName;
      topLevelFiles = @(Get-ChildItem -LiteralPath $entry.FullName -File -ErrorAction SilentlyContinue | Select-Object Name, Length);
      extractedDirectoryExists = (Test-Path -LiteralPath $extracted -PathType Container);
      extractedFileCount = $extractedFiles.Count; extractedBytes = ($extractedFiles | Measure-Object Length -Sum).Sum }
  }
  return [ordered]@{ time = [DateTime]::UtcNow.ToString('o'); processes = $processes;
    windows = @([MelodyDiagnosticWindows]::Capture([int[]]@($processes | ForEach-Object ProcessId))); runtime = $runtime; nsisPlugins = $plugins }
}

function Test-ProcessIdentity([int]$ProcessId, $CreationDate) {
  if ($null -eq $CreationDate -or -not $knownProcessStarts.ContainsKey($ProcessId)) { return $false }
  # CIM and Process.StartTime may differ in submillisecond precision.
  return [Math]::Abs(($CreationDate.ToUniversalTime() - $knownProcessStarts[$ProcessId]).TotalMilliseconds) -lt 1
}

function Save-RuntimeEvidence {
  $tree = @()
  foreach ($root in $runtimeRoots) {
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
    $files = @(Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue)
    foreach ($file in $files | Select-Object -First 2000) {
      $tree += [ordered]@{ root = $root; path = [IO.Path]::GetRelativePath($root, $file.FullName);
        bytes = $file.Length; modifiedAt = $file.LastWriteTimeUtc.ToString('o') }
    }
    $summary[('runtimeFiles:' + $root)] = $files.Count
  }
  Write-ReportJson 'runtime-files.json' @($tree)
  $pluginTree = @()
  foreach ($root in $knownPluginDirectories) {
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
    foreach ($file in @(Get-ChildItem -LiteralPath $root -File -Recurse -ErrorAction SilentlyContinue) | Select-Object -First 2000) {
      $pluginTree += [ordered]@{ root = $root; path = [IO.Path]::GetRelativePath($root, $file.FullName); bytes = $file.Length }
    }
  }
  Write-ReportJson 'nsis-plugin-files.json' @($pluginTree)
}

$priorEnvironment = @{}
foreach ($name in @('MELODY_SMOKE_RESULT', 'ELECTRON_ENABLE_LOGGING', 'ELECTRON_LOG_FILE', 'ELECTRON_RUN_AS_NODE')) {
  $priorEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
try {
  $artifacts = @(Get-ChildItem -LiteralPath $ArtifactDirectory -File -Filter '*.exe')
  if ($artifacts.Count -ne 1) { throw 'Expected exactly one original portable EXE' }
  $executable = $artifacts[0].FullName
  $runtimeRoots = @((Join-Path $artifacts[0].DirectoryName 'Melody/runtime'), (Join-Path $env:LOCALAPPDATA 'MelodyOfOblivion/runtime'))
  $summary.executable = $executable
  $summary.packageBytes = $artifacts[0].Length
  $summary.packageSha256 = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant()
  $summary.runnerArchitecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
  $env:MELODY_SMOKE_RESULT = $resultFile
  $env:ELECTRON_ENABLE_LOGGING = '1'
  $env:ELECTRON_LOG_FILE = $chromiumLog
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  $wrapper = Start-Process -FilePath $executable -ArgumentList @('--smoke-test', '--enable-logging', ('"--log-file=' + $chromiumLog + '"')) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $reportRoot 'stdout.log') -RedirectStandardError (Join-Path $reportRoot 'stderr.log')
  # Retain the process handle so PowerShell can report a fast child's exit code.
  $null = $wrapper.Handle
  [void]$knownProcessIds.Add($wrapper.Id)
  $knownProcessStarts[$wrapper.Id] = $wrapper.StartTime.ToUniversalTime()
  $summary.wrapperPid = $wrapper.Id
  $timer = [Diagnostics.Stopwatch]::StartNew()
  do {
    $observation = Get-PackageObservation
    $observation | ConvertTo-Json -Depth 12 -Compress | Add-Content -LiteralPath $observationsPath -Encoding utf8
    $wrapper.Refresh()
    Write-Output ('Observed {0:N0}s: {1} package processes, {2} windows, runtime complete={3}, NSIS extracted files={4}' -f $timer.Elapsed.TotalSeconds, @($observation.processes).Count, @($observation.windows).Count, (@($observation.runtime | Where-Object complete).Count), (@($observation.nsisPlugins | ForEach-Object extractedFileCount) -join ','))
    if ($wrapper.HasExited -or $timer.Elapsed.TotalSeconds -ge $TimeoutSeconds) { break }
    $remainingMs = [int][Math]::Max(1, ($TimeoutSeconds * 1000) - $timer.ElapsedMilliseconds)
    [void]$wrapper.WaitForExit([Math]::Min(5000, $remainingMs))
  } while ($true)
  $summary.elapsedMs = $timer.ElapsedMilliseconds
  $summary.exited = $wrapper.HasExited
  if (-not $wrapper.HasExited) { throw "Original portable EXE did not exit within $TimeoutSeconds seconds" }
  $summary.wrapperExitCode = $wrapper.ExitCode
  if ($wrapper.ExitCode -ne 0) {
    $diagnosticExitCode = $wrapper.ExitCode
    throw "Original portable EXE failed with exit code $($wrapper.ExitCode)"
  }
  if (-not (Test-Path -LiteralPath $resultFile)) { throw 'Original portable EXE exited without a smoke report' }
  $result = Get-Content -LiteralPath $resultFile -Raw | ConvertFrom-Json
  $summary.smokeReport = $result
  if (-not $result.ok -or -not $result.packaged -or $result.platform -ne 'win32' -or $result.arch -ne $ExpectedArch) {
    throw 'Smoke report does not match the requested packaged architecture'
  }
  $summary.ok = $true
  $diagnosticExitCode = 0
} catch {
  $summary.ok = $false
  $summary.error = $_.Exception.Message
  Write-Output ('DIAGNOSTIC_FAILURE: ' + $_.Exception.Message)
} finally {
  # Preserve evidence before terminating only this package's remaining processes.
  try { Write-ReportJson 'final-observation.json' (Get-PackageObservation) } catch { $summary.observationError = $_.Exception.Message }
  try { Save-RuntimeEvidence } catch { $summary.runtimeEvidenceError = $_.Exception.Message }
  $startupFile = Join-Path ([IO.Path]::GetTempPath()) 'melody-of-oblivion-smoke/logs/startup-latest.json'
  if ((Test-Path -LiteralPath $startupFile) -and (Get-Item -LiteralPath $startupFile).LastWriteTimeUtc -ge $startedAt) {
    try { Copy-Item -LiteralPath $startupFile -Destination (Join-Path $reportRoot 'startup-latest.json') } catch { $summary.startupLogError = $_.Exception.Message }
  }
  try {
    $events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $startedAt.ToLocalTime() } -ErrorAction SilentlyContinue |
      Where-Object { $_.ProviderName -in @('Application Error', 'Windows Error Reporting', 'SideBySide') -and $_.Message -match 'Melody|electron|diagnostic-package' } |
      Select-Object -First 50 TimeCreated, Id, ProviderName, LevelDisplayName, Message)
    Write-ReportJson 'application-errors.json' $events
  } catch { $summary.eventLogError = $_.Exception.Message }
  foreach ($processId in $knownProcessIds) {
    $candidate = $null
    try {
      $candidate = Get-Process -Id $processId -ErrorAction Stop
      # Retain the handle and kill that process object, never a freshly looked
      # up PID which might belong to a different process after it exits.
      $null = $candidate.Handle
      if (Test-ProcessIdentity $processId $candidate.StartTime) { $candidate.Kill() }
    } catch { } finally { if ($candidate) { $candidate.Dispose() } }
  }
  foreach ($name in $priorEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $priorEnvironment[$name], 'Process') }
  $summary.finishedAt = [DateTime]::UtcNow.ToString('o')
  $summary.diagnosticExitCode = $diagnosticExitCode
  Write-ReportJson 'summary.json' $summary
}
exit $diagnosticExitCode
