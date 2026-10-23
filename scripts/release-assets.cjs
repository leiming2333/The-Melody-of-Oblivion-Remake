'use strict';

const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { targets } = require('./release-targets.cjs');
const { versions } = require('./toolchain.cjs');

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const data of createReadStream(file)) hash.update(data);
  return hash.digest('hex');
}

async function walk(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Release input contains a symbolic link: ${filename}`);
    if (entry.isDirectory()) files.push(...await walk(filename));
    else if (entry.isFile()) files.push(filename);
  }
  return files;
}

function assertTag(tag, version) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag || '') || tag !== `v${version}`) throw new Error(`Release tag ${tag} does not match version ${version}`);
}

function checksumLines(assets) {
  return [...assets].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    .map(asset => `${asset.sha256}  ${asset.name}\n`).join('');
}

async function collectPackages(directory) {
  const files = (await walk(directory)).filter(file => /\.(?:exe|zip|AppImage)$/i.test(file));
  if (files.length !== targets.length) throw new Error(`Expected ${targets.length} packages, received ${files.length}`);
  const packages = [];
  for (const target of targets) {
    const matches = files.filter(file => path.basename(file) === target.filename);
    if (matches.length !== 1) throw new Error(`Missing or duplicate package: ${target.filename}`);
    const file = matches[0];
    const stat = await fs.stat(file);
    if (stat.size <= 0) throw new Error(`Empty release package: ${target.filename}`);
    packages.push({ target, file, name: target.filename, size: stat.size, sha256: await hashFile(file) });
  }
  return packages;
}

async function verifyManifest(directory, manifest) {
  if (manifest.schemaVersion !== 1) throw new Error('Unsupported release manifest');
  assertTag(manifest.tag, manifest.version);
  const packages = await collectPackages(directory);
  if (manifest.assets?.length !== targets.length) throw new Error('Incomplete release manifest');
  for (const item of packages) {
    const entries = manifest.assets.filter(asset => asset.name === item.name);
    const asset = entries[0];
    if (entries.length !== 1 || asset.sha256 !== item.sha256 || asset.size !== item.size || asset.target !== item.target.id) throw new Error(`Release manifest mismatch: ${item.name}`);
  }
  return packages;
}

async function prepareRelease(input, output, { tag, commit, smokeDirectory, version = require('../package.json').version } = {}) {
  assertTag(tag, version);
  if (!/^[a-f\d]{40}$/i.test(commit || '')) throw new Error('Release requires a full source commit');
  if (path.resolve(input) === path.resolve(output)) throw new Error('Release input and output must differ');
  const packages = await collectPackages(input);
  const smokeFiles = await walk(smokeDirectory);
  const assets = [];
  const lockSha256 = await hashFile(path.join(__dirname, '../package-lock.json'));
  for (const item of packages) {
    const metadata = JSON.parse(await fs.readFile(path.join(path.dirname(item.file), 'build-metadata.json'), 'utf8'));
    if (metadata.target !== item.target.id || metadata.version !== version || metadata.commit !== commit || metadata.sourceDirty !== false || metadata.lockSha256 !== lockSha256
      || JSON.stringify(metadata.toolchain) !== JSON.stringify(versions) || metadata.filename !== item.name || metadata.size !== item.size || metadata.sha256 !== item.sha256) throw new Error(`Invalid build metadata: ${item.name}`);
    let smoke = { status: 'not-verified', reason: 'No runtime acceptance for this target' };
    let upgrade = { status: 'not-verified', reason: 'No runtime acceptance for this target' };
    if (item.target.smokeRunner) {
      const emulated = item.target.emulated;
      const mechanism = item.target.emulatedBy;
      const matchesEvidence = (report) => !emulated || (report.native === false && report.emulatedBy === mechanism);
      const matchesArch = (report) => report.arch === item.target.arch
        || (emulated && item.target.arch === 'armv7l' && report.arch === 'arm');
      const matches = smokeFiles.filter(file => path.basename(file) === `smoke-${item.target.id}.json`);
      if (matches.length !== 1) throw new Error(`Missing smoke evidence: ${item.target.id}`);
      const report = JSON.parse(await fs.readFile(matches[0], 'utf8'));
      if (!report.ok || !report.packaged || report.platform !== item.target.platform || !matchesArch(report) || report.version !== version
        || report.artifactSha256 !== item.sha256 || report.artifact !== item.name || !matchesEvidence(report)) throw new Error(`Smoke report mismatch: ${item.target.id}`);
      smoke = { status: emulated ? 'passed-emulated' : 'passed', ...(emulated ? { emulatedBy: mechanism } : {}), report };
      const upgradeFiles = smokeFiles.filter(file => path.basename(file) === `upgrade-${item.target.id}.json`);
      if (upgradeFiles.length !== 1) throw new Error(`Missing upgrade evidence: ${item.target.id}`);
      const upgradeReport = JSON.parse(await fs.readFile(upgradeFiles[0], 'utf8'));
      if (!upgradeReport.ok || upgradeReport.target !== item.target.id || upgradeReport.version !== version || upgradeReport.artifactSha256 !== item.sha256
        || upgradeReport.artifact !== item.name || upgradeReport.upgrades !== 2 || !upgradeReport.previousBackupPreserved || !upgradeReport.olderManagedBackupCleaned
        || upgradeReport.previousVersion !== '0.0.0' || !upgradeReport.previousReport?.ok || !upgradeReport.previousReport.packaged
        || upgradeReport.previousReport.version !== '0.0.0' || !matchesArch(upgradeReport.previousReport) || upgradeReport.previousReport.platform !== item.target.platform
        || (item.target.platform === 'darwin' && upgradeReport.manualPermissionFallbackPassed !== true)
        || !matchesEvidence(upgradeReport)) throw new Error(`Upgrade report mismatch: ${item.target.id}`);
      upgrade = { status: emulated ? 'passed-emulated' : 'passed', ...(emulated ? { emulatedBy: mechanism } : {}), report: upgradeReport };
    }
    assets.push({ name: item.name, target: item.target.id, platform: item.target.platform, arch: item.target.arch, size: item.size, sha256: item.sha256, build: metadata, smoke, upgrade });
  }
  const manifest = { schemaVersion: 1, tag, version, commit, lockSha256, toolchain: versions, assets };
  await fs.mkdir(output, { recursive: true });
  if ((await fs.readdir(output)).length) throw new Error('Release output directory must be empty');
  for (const item of packages) {
    await fs.copyFile(item.file, path.join(output, item.name));
    await fs.writeFile(path.join(output, `${item.name}.sha256`), `${item.sha256}  ${item.name}\n`);
  }
  await fs.writeFile(path.join(output, 'SHA256SUMS'), checksumLines(assets));
  await fs.writeFile(path.join(output, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (require.main === module) {
  const [input, output, smokeDirectory] = process.argv.slice(2);
  prepareRelease(input, output, { tag: process.env.RELEASE_TAG, commit: process.env.GITHUB_SHA, smokeDirectory })
    .then(manifest => console.log(`Verified ${manifest.assets.length} final packages for ${manifest.tag}`))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = { hashFile, walk, assertTag, checksumLines, collectPackages, verifyManifest, prepareRelease };
