function replacementScript(source, destination) {
  const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
  return `
$ErrorActionPreference = 'Stop'
$source = ${literal(source)}
$destination = ${literal(destination)}
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

module.exports = { replacementScript };
