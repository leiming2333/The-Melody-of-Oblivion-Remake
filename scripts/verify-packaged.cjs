const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

async function verify(binary, args = [], {
  timeoutMs = 60000, requirePackaged = true, expectedArch = process.arch, expectedVersion,
  reportPath, artifactPath
} = {}) {
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
    if (!result.ok || (requirePackaged && !result.packaged) || result.platform !== process.platform || result.arch !== expectedArch
      || (expectedVersion && result.version !== expectedVersion)) {
      throw new Error('Smoke report does not match the expected packaged application');
    }
    if (artifactPath) {
      const { hashFile } = require('./release-assets.cjs');
      result.artifactSha256 = await hashFile(artifactPath);
      result.artifact = path.basename(artifactPath);
    }
    if (reportPath) {
      await fs.mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
      await fs.writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`);
    }
    console.log(JSON.stringify(result));
    return result;
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

if (require.main === module) {
  const cliArgs = process.argv.slice(2);
  const options = {};
  while (cliArgs[0]?.startsWith('--')) {
    const flag = cliArgs.shift();
    const key = { '--expected-arch': 'expectedArch', '--expected-version': 'expectedVersion', '--report': 'reportPath', '--artifact': 'artifactPath' }[flag];
    if (!key || !cliArgs[0] || cliArgs[0].startsWith('--')) {
      console.error(`Invalid verification option: ${flag}`);
      process.exitCode = 1;
      break;
    }
    options[key] = cliArgs.shift();
  }
  const [binary, ...args] = cliArgs;
  if (process.exitCode || !binary || (options.expectedArch && !['x64', 'ia32', 'arm64', 'arm'].includes(options.expectedArch))) {
    console.error('Usage: node scripts/verify-packaged.cjs [--expected-arch <arch>] [--expected-version <version>] [--report <json>] [--artifact <package>] <executable> [arguments]');
    process.exitCode = 1;
  } else verify(binary, args, options).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { verify };
