const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;

function waitForExitScript(parentPid) {
  if (!Number.isInteger(parentPid) || parentPid <= 0 || parentPid > 0x7fffffff) {
    throw new Error('更新等待的进程标识无效');
  }
  return `
# Wait for Electron itself to exit and release the single-instance lock.
# A wrapper's executable may already be unlocked while Electron is still alive.
$launcherProcess = Get-Process -Id ${parentPid} -ErrorAction SilentlyContinue
if ($launcherProcess -and -not $launcherProcess.WaitForExit(120000)) {
  throw 'Previous launcher did not exit; the verified update remains available'
}
`;
}

function launchScript(destination, parentPid = process.pid) {
  return `
$ErrorActionPreference = 'Stop'
$destination = ${literal(destination)}
${waitForExitScript(parentPid)}
Start-Process -FilePath $destination -WindowStyle Hidden
`;
}

function replacementScript(source, destination, parentPid = process.pid) {
  return `
$ErrorActionPreference = 'Stop'
$source = ${literal(source)}
$destination = ${literal(destination)}
${waitForExitScript(parentPid)}
$backup = $destination + '.old'
$deadline = [DateTime]::UtcNow.AddMinutes(2)
$replaced = $false
while ([DateTime]::UtcNow -lt $deadline) {
  try {
    if (Test-Path -LiteralPath $destination) {
      # The portable wrapper keeps its EXE locked until Electron exits.
      if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }
      Move-Item -LiteralPath $destination -Destination $backup
    }
    try {
      Move-Item -LiteralPath $source -Destination $destination
    } catch {
      if (Test-Path -LiteralPath $backup) { Move-Item -LiteralPath $backup -Destination $destination }
      throw
    }
    $replaced = $true
    break
  } catch { Start-Sleep -Milliseconds 500 }
}
if ($replaced) {
  Start-Process -FilePath $destination -WindowStyle Hidden
} else {
  # Preserve the verified download and relaunch the previous launcher on failure.
  Start-Process -FilePath $destination -WindowStyle Hidden
}
`;
}

module.exports = { launchScript, replacementScript };
