const path = require('node:path');
const { execFile } = require('node:child_process');

// The portable wrapper holds the same gate while extracting or acquiring a live
// runtime lease. Cleanup cannot race a launcher starting an older cached build.
const cleanupScript = String.raw`
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($env:MELODY_RUNTIME_ROOT)
$current = $env:MELODY_RUNTIME_KEY
$gate = [Threading.Mutex]::new($false, 'Local\MelodyPortableRuntimeGate')
$held = $false
try {
  try { $held = $gate.WaitOne(1000) } catch [Threading.AbandonedMutexException] { $held = $true }
  if (-not $held) { exit 0 }
  $rootItem = Get-Item -LiteralPath $root
  if ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { exit 0 }
  if (-not (Test-Path -LiteralPath (Join-Path $root (Join-Path $current '.complete')))) { exit 0 }
  # Also protect runtimes launched directly, bypassing the portable wrapper.
  $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  $entries = @(Get-ChildItem -LiteralPath $root -Directory)
  $previous = $entries | Where-Object {
    $_.Name -match '^(32|64|ARM64)-[a-f0-9]{64}$' -and $_.Name -ne $current -and
    (Test-Path -LiteralPath (Join-Path $_.FullName '.complete'))
  } | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  foreach ($entry in $entries) {
    if ($entry.Name -eq $current -or ($previous -and $entry.Name -eq $previous.Name)) { continue }
    $completeName = $entry.Name -match '^(32|64|ARM64)-[a-f0-9]{64}$'
    $residueName = $entry.Name -match '^(32|64|ARM64)-[a-f0-9]{64}\.incomplete-\d+$|^ns[a-zA-Z][a-fA-F0-9]+\.tmp$'
    if (-not ($completeName -or $residueName)) { continue }
    # Recent interrupted extraction remains available for diagnosis/recovery.
    if ($residueName -and $entry.LastWriteTimeUtc -gt [DateTime]::UtcNow.AddDays(-1)) { continue }
    $target = [IO.Path]::GetFullPath($entry.FullName)
    if ([IO.Path]::GetDirectoryName($target) -ne $root) { continue }
    if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
    $prefix = $target + [IO.Path]::DirectorySeparatorChar
    if ($processes | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) }) { continue }
    $created = $false
    $leaseKey = $entry.Name -replace '\.incomplete-\d+$', ''
    $lease = [Threading.Mutex]::new($false, ('Local\MelodyPortableLive-' + $leaseKey), [ref]$created)
    try {
      if (-not $created) { continue }
      # Never recursively remove junctions or symlinks, including nested ones.
      if (Get-ChildItem -LiteralPath $target -Recurse -Force -ErrorAction Stop | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { continue }
      Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
    } catch {
      # A locked file or permission failure must not interfere with startup.
    } finally { $lease.Dispose() }
  }
} finally {
  if ($held) { $gate.ReleaseMutex() }
  $gate.Dispose()
}
`;

function cleanupPortableRuntime({ executable = process.execPath, env = process.env } = {}) {
  const directory = path.dirname(executable);
  const key = path.basename(directory);
  if (process.platform !== 'win32' || !env.PORTABLE_EXECUTABLE_DIR
    || !/^(32|64|ARM64)-[a-f0-9]{64}$/.test(key)
    || path.basename(path.dirname(directory)) !== 'runtime') return Promise.resolve();
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(cleanupScript, 'utf16le').toString('base64')], {
      windowsHide: true,
      timeout: 30000,
      env: { ...env, MELODY_RUNTIME_ROOT: path.dirname(directory), MELODY_RUNTIME_KEY: key }
    }, (error) => resolve(error ? { error: error.message } : { cleaned: true }));
  });
}

module.exports = { cleanupPortableRuntime, cleanupScript };
