const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

async function verify(binary, args = [], { timeoutMs = 60000, requirePackaged = true } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-package-smoke-'));
  const resultFile = path.join(directory, 'result.json');
  const env = { ...process.env, MELODY_SMOKE_RESULT: resultFile };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(path.resolve(binary), [...args, '--smoke-test'], { env, stdio: 'inherit', windowsHide: true });
      const timer = setTimeout(() => { child.kill(); reject(new Error('Packaged application smoke timed out')); }, timeoutMs);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Packaged application failed: code=${code}, signal=${signal}`));
      });
    });
    const result = JSON.parse(await fs.readFile(resultFile, 'utf8'));
    if (!result.ok || (requirePackaged && !result.packaged) || result.platform !== process.platform || result.arch !== process.arch) {
      throw new Error('Smoke report does not match the native packaged application');
    }
    console.log(JSON.stringify(result));
    return result;
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

if (require.main === module) {
  const [binary, ...args] = process.argv.slice(2);
  if (!binary) { console.error('Usage: node scripts/verify-packaged.cjs <native executable> [arguments]'); process.exitCode = 1; }
  else verify(binary, args).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { verify };
