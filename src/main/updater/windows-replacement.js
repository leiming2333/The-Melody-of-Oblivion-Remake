const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;

function waitForExitScript(parentPid, cancelPath = null) {
  if (!Number.isInteger(parentPid) || parentPid <= 0 || parentPid > 0x7fffffff) {
    throw new Error('更新等待的进程标识无效');
  }
  return `
# Wait for Electron itself to exit and release the single-instance lock.
# A wrapper's executable may already be unlocked while Electron is still alive.
$launcherProcess = Get-Process -Id ${parentPid} -ErrorAction SilentlyContinue
${cancelPath ? `$waitDeadline = [DateTime]::UtcNow.AddMinutes(2)
while ($launcherProcess -and -not $launcherProcess.WaitForExit(200)) {
  if (Test-Path -LiteralPath ${literal(cancelPath)}) { exit 0 }
  if ([DateTime]::UtcNow -ge $waitDeadline) { throw 'Previous launcher did not exit; the verified update remains available' }
}
if (Test-Path -LiteralPath ${literal(cancelPath)}) { exit 0 }` : `if ($launcherProcess -and -not $launcherProcess.WaitForExit(120000)) {
  throw 'Previous launcher did not exit; the verified update remains available'
}`}
`;
}

function launchScript(destination, parentPid = process.pid, { readyPath = null, cancelPath = null } = {}) {
  return `
$ErrorActionPreference = 'Stop'
$destination = ${literal(destination)}
${readyPath ? `[IO.File]::WriteAllText(${literal(readyPath)}, 'MELODY_UPDATE_READY')` : ''}
${waitForExitScript(parentPid, cancelPath)}
Start-Process -FilePath $destination -WindowStyle Hidden
`;
}

function replacementScript(source, destination, parentPid = process.pid, {
  backupPath = `${destination}.old`, journalPath = null, transactionId = null, ready = false,
  rollback = false, launchArguments = [], readyPath = null, cancelPath = null
} = {}) {
  const launch = `Start-Process -FilePath $destination -WindowStyle Hidden${launchArguments.length ? ` -ArgumentList @(${launchArguments.map(literal).join(', ')})` : ''}`;
  return `
$ErrorActionPreference = 'Stop'
$source = ${literal(source)}
$destination = ${literal(destination)}
$backup = ${literal(backupPath)}
$journal = ${journalPath ? literal(journalPath) : '$null'}
$transactionId = ${transactionId ? literal(transactionId) : '$null'}
function Save-Phase([string]$phase, [string]$message = '') {
  if (-not $journal) { return }
  $report = Get-Content -LiteralPath $journal -Raw -Encoding UTF8 | ConvertFrom-Json
  $record = @($report.records | Where-Object { $_.id -eq $transactionId })
  if ($record.Count -ne 1) { throw 'Update transaction disappeared' }
  $record[0].phase = $phase
  $record[0].error = $message
  $temporary = $journal + '.helper-' + [Guid]::NewGuid().ToString() + '.tmp'
  try {
    [IO.File]::WriteAllText($temporary, ($report | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
    [IO.File]::Replace($temporary, $journal, [NullString]::Value)
  } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw 'Verified update file is missing' }
Save-Phase 'prepared'
${readyPath ? `[IO.File]::WriteAllText(${literal(readyPath)}, 'MELODY_UPDATE_READY')` : ready ? "[Console]::WriteLine('MELODY_UPDATE_READY'); [Console]::Out.Flush()" : ''}
${waitForExitScript(parentPid, cancelPath)}
$deadline = [DateTime]::UtcNow.AddMinutes(2)
$replaced = $false
try { Save-Phase 'applying' } catch { ${launch}; throw }
while ([DateTime]::UtcNow -lt $deadline) {
  try {
    if (Test-Path -LiteralPath $destination) {
      if (Test-Path -LiteralPath $backup) { throw 'Refusing to overwrite an existing recovery backup' }
      # Same-volume ReplaceFile preserves an executable at the original pathname.
      [IO.File]::Replace($source, $destination, $backup)
    } else { [IO.File]::Move($source, $destination) }
    $replaced = $true
    break
  } catch { $failure = $_.Exception.Message; Start-Sleep -Milliseconds 500 }
}
if ($replaced) {
  try {
    Save-Phase '${rollback ? 'rolled-back' : 'awaiting-health'}'
    ${launch}
  } catch {
    $failure = $_.Exception.Message
    if (Test-Path -LiteralPath $backup) {
      [IO.File]::Replace($backup, $destination, $source)
      try { Save-Phase 'rolled-back' $failure } catch {}
      ${launch}
    } else { Save-Phase 'failed' $failure; throw }
  }
} else {
  Save-Phase 'failed' $failure
  ${launch}
}
`;
}

module.exports = { launchScript, replacementScript };
