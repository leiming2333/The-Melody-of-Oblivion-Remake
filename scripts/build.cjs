'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { targets } = require('./release-targets.cjs');
const { versions, assertToolchain } = require('./toolchain.cjs');
const root = path.resolve(__dirname, '..');

function selectTarget(args, host = { platform: process.platform, arch: process.arch }) {
  let platform = host.platform;
  let arch = host.arch === 'arm' ? 'armv7l' : host.arch;
  let requested;
  let fixture = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--target') requested = args[++i];
    else if (arg === '--upgrade-fixture') fixture = true;
    else if (['--win', '--linux', '--mac'].includes(arg)) platform = { '--win': 'win32', '--linux': 'linux', '--mac': 'darwin' }[arg];
    else if (['--x64', '--ia32', '--arm64', '--armv7l'].includes(arg)) arch = arg.slice(2);
    else throw new Error(`Unsupported build argument: ${arg}. Use --target <id> or a platform/architecture flag.`);
  }
  const target = targets.find(item => requested ? item.id === requested : item.platform === platform && item.arch === arch);
  if (!target) throw new Error('Unsupported build target');
  return fixture ? { ...target, fixtureVersion: '0.0.0', output: `release/upgrade-fixtures/${target.id}` } : target;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true, ...options });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Build command failed: ${code ?? signal}`)));
  });
}

async function build(args = process.argv.slice(2)) {
  assertToolchain();
  const target = selectTarget(args);
  const pkg = require('../package.json');
  const lock = require('../package-lock.json');
  if (pkg.version !== lock.version || pkg.version !== lock.packages[''].version) throw new Error('Package and lockfile versions differ');
  const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : null;
  if (tag && tag !== `v${pkg.version}`) throw new Error(`Release tag ${tag} does not match package version ${pkg.version}`);
  const { execFileSync } = require('node:child_process');
  const gitOptions = { cwd: root, encoding: 'utf8', windowsHide: true };
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], gitOptions).trim();
  const sourceDirty = Boolean(execFileSync('git', ['status', '--porcelain'], gitOptions).trim());
  if (tag && sourceDirty) throw new Error('Tagged release builds require a clean source checkout');
  const output = path.resolve(root, target.output);
  const allowedRoot = path.resolve(root, 'release', target.fixtureVersion ? 'upgrade-fixtures' : 'build');
  if (path.dirname(output) !== allowedRoot) throw new Error('Unsafe build output path');
  for (const directory of [path.join(root, 'release'), allowedRoot, output]) {
    const stat = await fs.lstat(directory).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (stat?.isSymbolicLink()) throw new Error(`Build output must not traverse a link: ${directory}`);
  }
  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(output, { recursive: true });
  const clientId = process.env.MELODY_MICROSOFT_CLIENT_ID || require('../src/main/accounts/microsoft-client-id.json').clientId;
  await run(process.execPath, [path.join(__dirname, 'generate-client-id.js')], { env: { ...process.env, MELODY_MICROSOFT_CLIENT_ID: clientId } });
  const builder = require.resolve('electron-builder/cli.js');
  const platformFlag = { win32: '--win', linux: '--linux', darwin: '--mac' }[target.platform];
  await run(process.execPath, [builder, platformFlag, `--${target.arch}`, '--publish', 'never', `--config.directories.output=${output}`,
    ...(target.fixtureVersion ? [`--config.extraMetadata.version=${target.fixtureVersion}`] : [])]);
  if (target.id === 'linux-x64') await fs.rename(path.join(output, target.filename.replace('x64.AppImage', 'x86_64.AppImage')), path.join(output, target.filename));
  const stat = await fs.stat(path.join(output, target.filename));
  if (!stat.isFile() || stat.size === 0) throw new Error('Build did not produce the expected nonempty package');
  const { createHash } = require('node:crypto');
  const metadata = {
    schemaVersion: 1, target: target.id, version: target.fixtureVersion || pkg.version, isUpgradeFixture: Boolean(target.fixtureVersion),
    commit, sourceDirty, microsoftClientId: clientId.toLowerCase(),
    lockSha256: createHash('sha256').update(await fs.readFile(path.join(root, 'package-lock.json'))).digest('hex'),
    toolchain: versions,
    runner: { label: process.env.GITHUB_ACTIONS ? target.runner : 'local', os: process.platform, arch: process.arch,
      image: process.env.ImageOS || null, imageVersion: process.env.ImageVersion || null },
    filename: target.filename, size: stat.size,
    sha256: await require('./release-assets.cjs').hashFile(path.join(output, target.filename))
  };
  await fs.writeFile(path.join(output, 'build-metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(`Built ${target.id}: ${path.join(output, target.filename)}`);
}

if (require.main === module) build().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { selectTarget, build };
