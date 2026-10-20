const { replacementScript } = require('./windows-replacement');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const shellLiteral = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

function macReplacementScript(record, journalPath, recordIndex, parentPid, { rollback = false, launchArguments = [] } = {}) {
  if (!Number.isInteger(parentPid) || parentPid <= 0) throw new Error('更新等待的进程标识无效');
  const launch = `/usr/bin/open "$destination"${launchArguments.length ? ` --args ${launchArguments.map(shellLiteral).join(' ')}` : ''}`;
  return `set -eu
source=${shellLiteral(record.sourcePath)}
destination=${shellLiteral(record.targetPath)}
backup=${shellLiteral(record.backupPath)}
journal=${shellLiteral(journalPath)}
save_phase() {
  temp="$journal.helper-$$.tmp"
  /bin/cp "$journal" "$temp"
  /usr/bin/plutil -replace records.${recordIndex}.phase -string "$1" "$temp"
  /usr/bin/plutil -replace records.${recordIndex}.error -string "\x24{2-}" "$temp"
  /usr/bin/plutil -convert json "$temp"
  /bin/mv -f "$temp" "$journal"
}
committed=0
restore_on_exit() {
  status=$?
  trap - EXIT
  if test "$status" -ne 0 && test "$committed" -eq 0 && test -d "$backup"; then
    if test -e "$destination" && test ! -e "$source"; then /bin/mv "$destination" "$source" || true; fi
    if test ! -e "$destination"; then
      if /bin/mv "$backup" "$destination"; then
        save_phase rolled-back '更新辅助程序失败，已恢复旧应用' || true
        ${launch} || true
      fi
    fi
  fi
  exit "$status"
}
trap restore_on_exit EXIT
trap 'exit 1' HUP INT TERM
test -d "$source/Contents/MacOS"
test ! -e "$backup"
save_phase prepared
printf 'MELODY_UPDATE_READY\\n'
deadline=$(( $(/bin/date +%s) + 120 ))
while /bin/kill -0 ${parentPid} 2>/dev/null; do
  if test "$(/bin/date +%s)" -ge "$deadline"; then
    save_phase failed '旧启动器未退出，已保留更新包'
    exit 1
  fi
  /bin/sleep 0.2
done
save_phase applying
if ! /bin/mv "$destination" "$backup"; then
  save_phase failed '无法备份旧应用，已保留更新包'
  ${launch} || true
  exit 1
fi
if ! /bin/mv "$source" "$destination"; then
  /bin/mv "$backup" "$destination" || { save_phase failed '替换和恢复均失败，请查看备份位置'; exit 1; }
  save_phase rolled-back '替换失败，已恢复旧应用'
  ${launch} || true
  exit 1
fi
save_phase ${rollback ? 'rolled-back' : 'awaiting-health'}
if ! ${launch}; then
  /bin/mv "$destination" "$source"
  /bin/mv "$backup" "$destination"
  save_phase rolled-back '新应用无法启动，已恢复旧应用'
  ${launch} || true
  exit 1
fi
committed=1
`;
}

function waitForHelper(spawnProcess, command, args, { signal, timeoutMs = 10000, failureCleanup } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    let output = '';
    let errorOutput = '';
    let settled = false;
    const abortError = () => Object.assign(new Error('更新安装准备已取消'), { name: 'AbortError', code: 'ABORT_ERR' });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      child?.removeListener?.('close', exited);
      child?.removeListener?.('error', failed);
      child?.on?.('error', () => {});
      child?.stdout?.removeListener('data', received);
      child?.stderr?.removeListener('data', receivedError);
      if (error) {
        child?.kill?.();
        Promise.resolve().then(() => failureCleanup?.()).catch(() => {}).then(() => reject(error));
      }
      else {
        child?.stdout?.destroy?.();
        child?.stderr?.destroy?.();
        child?.unref?.();
        resolve(child);
      }
    };
    const abort = () => finish(abortError());
    const failed = (error) => finish(error);
    const exited = (code) => finish(new Error(`更新辅助程序未就绪（退出码 ${code}）${errorOutput ? `：${errorOutput}` : ''}${output ? `；${output}` : ''}`));
    const received = (chunk) => {
      output = (output + chunk.toString()).slice(-4096);
      if (output.includes('MELODY_UPDATE_READY\n') || output.includes('MELODY_UPDATE_READY\r\n')) finish();
    };
    const receivedError = (chunk) => { errorOutput = (errorOutput + chunk.toString()).slice(-1500); };
    const timer = setTimeout(() => finish(new Error('更新辅助程序准备超时，启动器保持运行')), timeoutMs);
    try {
      if (signal?.aborted) { finish(abortError()); return; }
      // DETACHED_PROCESS makes Windows PowerShell silently exit before executing
      // an encoded command on some Windows/Node versions. Windows children survive
      // parent exit without that flag; unref and close our pipe ends after ready.
      child = spawnProcess(command, args, { detached: process.platform !== 'win32', windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'] });
      if (!child?.once || !child.stdout?.on) throw new Error('更新辅助程序缺少就绪通道');
      child.once('error', failed);
      // close follows the final stdout/stderr data; exit can precede those bytes.
      child.once('close', exited);
      child.stdout.on('data', received);
      child.stderr?.on('data', receivedError);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    } catch (error) { finish(error); }
  });
}

async function startWindowsHelper({ makeScript, directory, fileSystem = fs, spawnProcess, signal }) {
  const session = `helper-${crypto.randomUUID()}`;
  const readyPath = path.join(directory, `${session}.ready`);
  const cancelPath = path.join(directory, `${session}.cancel`);
  const scriptPath = path.join(directory, `${session}.ps1`);
  const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const script = makeScript({ readyPath, cancelPath });
  // A script file avoids Windows' 32K command-line limit. The BOM is needed by
  // Windows PowerShell 5 when installation paths contain Chinese characters.
  let scriptArguments;
  if (typeof fileSystem.writeFile === 'function') {
    await fileSystem.writeFile(scriptPath, `\ufeff${script}`, { mode: 0o600 });
    scriptArguments = `'-ExecutionPolicy', 'Bypass', '-File', ${literal(`"${scriptPath}"`)}`;
  } else scriptArguments = `'-EncodedCommand', '${Buffer.from(script, 'utf16le').toString('base64')}'`;
  // ShellExecute (Start-Process with a window style and no redirected streams)
  // gives the real helper its own hidden console. Direct PowerShell children can
  // terminate with Electron's console even when their Node handle is unreferenced.
  const bootstrap = `$ErrorActionPreference = 'Stop'
try {
$helper = Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile', '-NonInteractive', ${scriptArguments}) -PassThru
while (-not (Test-Path -LiteralPath ${literal(readyPath)})) {
  if (Test-Path -LiteralPath ${literal(cancelPath)}) { Stop-Process -Id $helper.Id -ErrorAction SilentlyContinue; exit 1 }
  if ($helper.HasExited) { throw '更新辅助程序在确认就绪前退出' }
  Start-Sleep -Milliseconds 20
}
if (([IO.File]::ReadAllText(${literal(readyPath)})) -ne 'MELODY_UPDATE_READY') { throw '更新辅助程序就绪确认无效' }
[Console]::WriteLine('MELODY_UPDATE_READY'); [Console]::Out.Flush()
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
`;
  const cancel = () => fileSystem.writeFile?.(cancelPath, 'cancelled', { mode: 0o600 });
  const child = await waitForHelper(spawnProcess, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(bootstrap, 'utf16le').toString('base64')], { signal, failureCleanup: cancel });
  const killBootstrap = child.kill?.bind(child);
  child.kill = () => { Promise.resolve(cancel()).catch(() => {}); return killBootstrap?.(); };
  return child;
}

async function startInstallHelper({ record, store, platform, spawnProcess, parentPid = process.pid, signal, rollback = false, launchArguments = [] }) {
  if (platform === 'win32') {
    return startWindowsHelper({ directory: record.stagingRoot, fileSystem: store.fs, spawnProcess, signal,
      makeScript: ({ readyPath, cancelPath }) => replacementScript(record.sourcePath, record.targetPath, parentPid, {
      backupPath: record.backupPath, journalPath: store.persistent ? store.filePath : null,
      transactionId: record.id, ready: true, rollback, launchArguments, readyPath, cancelPath
    }) });
  }
  const script = macReplacementScript(record, store.filePath, store.records.findIndex((entry) => entry.id === record.id), parentPid, { rollback, launchArguments });
  return waitForHelper(spawnProcess, '/bin/sh', ['-c', script], { signal });
}

module.exports = { macReplacementScript, waitForHelper, startWindowsHelper, startInstallHelper };
