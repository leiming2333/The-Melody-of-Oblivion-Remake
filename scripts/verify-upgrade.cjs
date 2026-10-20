'use strict';

const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const { targets } = require('./release-targets.cjs');
const { hashFile } = require('./release-assets.cjs');
const { verify } = require('./verify-packaged.cjs');
const { UpdateManager } = require('../src/main/updater/update-manager');
const { startInstallHelper } = require('../src/main/updater/install-helper');
const run = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function hashInstallation(filename) {
  if (!(await fs.lstat(filename)).isDirectory()) return hashFile(filename);
  const hash = createHash('sha256');
  async function visit(directory, relative = '') {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const name = path.join(relative, entry.name);
      const file = path.join(directory, entry.name);
      hash.update(name.replaceAll('\\', '/')); hash.update('\0');
      if (entry.isSymbolicLink()) { hash.update('link\0'); hash.update(await fs.readlink(file)); }
      else if (entry.isDirectory()) { hash.update('directory\0'); await visit(file, name); }
      else { hash.update('file\0'); for await (const chunk of createReadStream(file)) hash.update(chunk); }
      hash.update('\0');
    }
  }
  await visit(filename);
  return hash.digest('hex');
}

async function waitUntil(read, message, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await pause(200);
  }
  throw new Error(message);
}

async function verifyUpgrade({ target: targetId, artifact, previousArtifact, report: reportPath }) {
  const target = targets.find(item => item.id === targetId);
  if (!target?.smokeRunner || target.platform !== process.platform) throw new Error('Upgrade smoke requires a native runnable target');
  const packagePath = path.resolve(artifact);
  const previousPackage = path.resolve(previousArtifact);
  if (previousPackage === packagePath) throw new Error('Upgrade smoke requires distinct previous and new packages');
  if (path.basename(packagePath) !== target.filename) throw new Error('Unexpected upgrade package name');
  const version = require('../package.json').version;
  const packageHash = await hashFile(packagePath);
  const previousPackageHash = await hashFile(previousPackage);
  if (previousPackageHash === packageHash) throw new Error('Previous test package must contain a different version');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-real-upgrade-'));
  const userData = path.join(directory, 'user-data');
  const smokeResult = path.join(directory, 'new-package-smoke.json');
  let installation;
  let executable;
  let expectedInstallationHash;
  let launchPromise;
  let helperOutput = '';
  let succeeded = false;
  try {
    if (target.platform === 'darwin') {
      const extracted = path.join(directory, 'initial');
      await run('/usr/bin/ditto', ['-x', '-k', previousPackage, extracted]);
      const bundles = (await fs.readdir(extracted)).filter(name => name.endsWith('.app'));
      if (bundles.length !== 1) throw new Error('Expected one application bundle');
      installation = path.join(directory, bundles[0]);
      await fs.rename(path.join(extracted, bundles[0]), installation);
      const binaries = await fs.readdir(path.join(installation, 'Contents', 'MacOS'));
      if (binaries.length !== 1) throw new Error('Expected one application executable');
      executable = path.join(installation, 'Contents', 'MacOS', binaries[0]);
      const newExtracted = path.join(directory, 'expected-new');
      await run('/usr/bin/ditto', ['-x', '-k', packagePath, newExtracted]);
      const newBundles = (await fs.readdir(newExtracted)).filter(name => name.endsWith('.app'));
      if (newBundles.length !== 1) throw new Error('Expected one new application bundle');
      expectedInstallationHash = await hashInstallation(path.join(newExtracted, newBundles[0]));
    } else {
      installation = path.join(directory, target.platform === 'win32' ? '我的启动器.exe' : 'custom-launcher.AppImage');
      executable = installation;
      await fs.copyFile(previousPackage, installation);
      if (target.platform === 'linux') await fs.chmod(installation, 0o755);
    }
    const originalHash = await hashInstallation(installation);
    if (target.platform !== 'darwin') expectedInstallationHash = packageHash;
    const release = { tag_name: `v${version}`, draft: false, prerelease: false, assets: [{
      name: target.filename, size: (await fs.stat(packagePath)).size,
      digest: `sha256:${packageHash}`, browser_download_url: 'https://update-fixture.invalid/package'
    }] };
    async function launchLinux(expectedVersion = version, reportPath = smokeResult) {
      const extract = await fs.mkdtemp(path.join(directory, 'linux-run-'));
      await run(installation, ['--appimage-extract'], { cwd: extract, maxBuffer: 16 * 1024 * 1024 });
      return verify(path.join(extract, 'squashfs-root', 'AppRun'), ['--no-sandbox'], {
        expectedArch: target.arch, expectedVersion, reportPath
      });
    }
    const previousReportPath = path.join(directory, 'previous-package-smoke.json');
    const previousReport = target.platform === 'linux'
      ? await launchLinux('0.0.0', previousReportPath)
      : await verify(executable, [], { expectedArch: target.arch, expectedVersion: '0.0.0', reportPath: previousReportPath });
    function manager(currentVersion) {
      return new UpdateManager({
        app: { isPackaged: true, getVersion: () => currentVersion,
          getPath: name => name === 'exe' ? executable : name === 'userData' ? userData : directory,
          quit() {}, relaunch() { launchPromise = launchLinux(); } },
        installationTarget: installation, platform: target.platform, arch: target.arch,
        env: { ...process.env, PORTABLE_EXECUTABLE_FILE: installation, PORTABLE_EXECUTABLE_DIR: directory, APPIMAGE: installation },
        fetchImpl: async () => new Response(JSON.stringify(release), { status: 200, headers: { 'content-type': 'application/json' } }),
        downloadFile: async (_url, destination, progress) => { await fs.copyFile(packagePath, destination); progress(100); },
        spawnProcess: (command, args, options) => {
          const child = spawn(command, args, { ...options, env: { ...process.env, MELODY_SMOKE_RESULT: smokeResult } });
          for (const stream of [child.stdout, child.stderr]) stream?.on('data', data => { helperOutput = (helperOutput + data.toString()).slice(-32000); });
          return child;
        },
        startHelper: options => startInstallHelper({ ...options, parentPid: 0x7fffffff,
          launchArguments: ['--smoke-test', `--smoke-result=${smokeResult}`] })
      });
    }
    const records = [];
    for (let generation = 0; generation < 2; generation++) {
      await fs.rm(smokeResult, { force: true });
      const updater = manager(generation === 0 ? '0.0.0' : version);
      let downloaded;
      if (generation === 0) downloaded = await updater.check();
      else {
        // Reinstall the same final package to exercise retention after a second
        // confirmed transaction without pretending a third version was built.
        await updater.initialize();
        updater.release = release;
        updater.setState({ status: 'available', availableVersion: version });
        downloaded = await updater.download();
      }
      if (downloaded.status !== 'downloaded') throw new Error(`Upgrade download failed: ${downloaded.message}`);
      const beforeHash = await hashInstallation(installation);
      const install = await updater.install();
      if (!install.installing) throw new Error(`Upgrade installation failed: ${install.message}`);
      const record = await waitUntil(async () => {
        await updater.store.load();
        const latest = updater.store.latest();
        if (['failed', 'rolled-back'].includes(latest.phase)) throw new Error(`Upgrade helper failed: ${latest.error}`);
        return latest.phase === 'awaiting-health' && latest;
      }, 'Upgrade helper did not commit its transaction');
      if (launchPromise) { await launchPromise; launchPromise = null; }
      const report = await waitUntil(async () => {
        try { return JSON.parse(await fs.readFile(smokeResult, 'utf8')); }
        catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
      }, 'Updated application did not produce a smoke report');
      if (!report.ok || !report.packaged || report.platform !== target.platform || report.arch !== target.arch || report.version !== version) throw new Error('Updated application report does not match the package');
      if (await hashInstallation(record.backupPath) !== beforeHash) throw new Error('Previous installation bytes were not preserved');
      if (expectedInstallationHash && await hashInstallation(installation) !== expectedInstallationHash) throw new Error('Installed package bytes differ from the verified download');
      const healthy = manager(version);
      await healthy.confirmHealthy();
      await healthy.store.load();
      if (healthy.store.latest().phase !== 'confirmed') throw new Error('Healthy startup was not confirmed');
      if (generation && await fs.lstat(records[0].backupPath).then(() => true, () => false)) throw new Error('Older managed backup was not cleaned after healthy confirmation');
      if (await hashInstallation(record.backupPath) !== beforeHash) throw new Error('Current recovery backup was removed');
      records.push({ ...record, smoke: report, installedHash: await hashInstallation(installation) });
    }
    const report = { ok: true, target: target.id, version, artifact: target.filename,
      artifactSha256: packageHash, previousFixtureSha256: originalHash,
      previousArtifactSha256: previousPackageHash, previousVersion: '0.0.0',
      previousPackage: 'Same source, isolated extraMetadata.version=0.0.0 test build',
      previousReport, healthyConfirmation: 'Explicit harness call after real packaged startup',
      backupCleanupReinstall: true, upgrades: records.length,
      previousBackupPreserved: true, olderManagedBackupCleaned: true,
      reports: records.map(record => record.smoke) };
    if (reportPath) { await fs.mkdir(path.dirname(path.resolve(reportPath)), { recursive: true }); await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); }
    succeeded = true;
    console.log(JSON.stringify(report));
    return report;
  } catch (error) {
    if (reportPath) {
      const journals = await fs.readdir(path.join(userData, 'updates')).catch(() => []);
      const transactions = [];
      for (const journal of journals.filter(name => name.endsWith('.json'))) {
        transactions.push(JSON.parse(await fs.readFile(path.join(userData, 'updates', journal), 'utf8')));
      }
      await fs.mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
      await fs.writeFile(reportPath, `${JSON.stringify({ ok: false, target: targetId, message: error.message,
        diagnosticsDirectory: directory, helperOutput, transactions }, null, 2)}\n`);
    }
    throw error;
  } finally {
    if (succeeded) {
      await pause(1000);
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = { '--target': 'target', '--artifact': 'artifact', '--previous-artifact': 'previousArtifact', '--report': 'report' }[args[index]];
    if (!key || !args[index + 1]) throw new Error('Usage: verify-upgrade.cjs --target <id> --artifact <package> --previous-artifact <0.0.0-package> --report <json>');
    options[key] = args[index + 1];
  }
  verifyUpgrade(options).catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = { verifyUpgrade, hashInstallation };
