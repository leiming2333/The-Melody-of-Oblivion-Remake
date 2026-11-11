'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { hashFile } = require('./release-assets.cjs');
const { targets } = require('./release-targets.cjs');
const { applyDeltaPatch, normalizeTag, readPatchManifest } = require('../src/main/updater/update-patch');
const exec = promisify(execFile);

const PATCH_MANIFEST_NAME = 'patch-manifest.json';
const DEFAULT_MAX_RATIO = 0.6;
const MAX_PATCH_RATIO = 0.95;
const MAX_SOURCES = 3;

function safeRelativeName(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 255
    && !/[\\/\u0000-\u001f]/.test(value) && value !== '.' && value !== '..';
}

async function defaultRunBsdiff(bsdiffPath, oldFile, newFile, patchFile) {
  await exec(bsdiffPath, [oldFile, newFile, patchFile, '--use-zstd'], {
    windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024
  });
}

function compareTagsDescending(left, right) {
  const a = left.replace(/^v/, '').split('.').map(Number);
  const b = right.replace(/^v/, '').split('.').map(Number);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return b[index] - a[index];
  return 0;
}

async function readPreviousManifest(directory, tag) {
  const normalized = normalizeTag(tag);
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'release-manifest.json'), 'utf8'));
  if (!normalized || normalizeTag(manifest?.tag) !== normalized) {
    throw new Error(`Previous release manifest does not match its tag: ${tag}`);
  }
  return manifest;
}

async function discoverPreviousReleases(previousDir, targetTag = null) {
  const entries = await fs.readdir(previousDir, { withFileTypes: true }).catch(() => []);
  const releases = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !safeRelativeName(entry.name)) continue;
    const directory = path.join(previousDir, entry.name);
    try {
      const manifest = await readPreviousManifest(directory, entry.name);
      if (normalizeTag(manifest.tag) === normalizeTag(targetTag)) continue;
      releases.push({ tag: manifest.tag, directory });
    } catch {
      // A manually populated flat directory is handled by the legacy fromTag path.
    }
  }
  return releases.sort((left, right) => compareTagsDescending(left.tag, right.tag)).slice(0, MAX_SOURCES);
}

async function generateSource({
  releaseDir, previous, fromTag, targetTag, bsdiffPath, maxRatio, runBsdiff, applyPatch, log
}) {
  const previousManifest = await readPreviousManifest(previous, fromTag);
  const releaseManifest = JSON.parse(await fs.readFile(path.join(releaseDir, 'release-manifest.json'), 'utf8'));
  if (normalizeTag(releaseManifest?.tag) !== targetTag) throw new Error('Current release manifest does not match its tag');
  const patches = [];
  for (const item of targets) {
    const asset = releaseManifest.assets?.find((entry) => entry?.name === item.filename);
    if (!asset || !/^[a-f0-9]{64}$/i.test(asset.sha256 ?? '') || !Number.isSafeInteger(asset.size)) {
      throw new Error(`Release manifest is missing ${item.filename}`);
    }
    const oldFile = path.join(previous, item.filename);
    const newFile = path.join(releaseDir, item.filename);
    const oldStat = await fs.stat(oldFile).catch(() => null);
    if (!oldStat?.isFile()) {
      log(`No ${fromTag} package for ${item.id}; skipping that source target`);
      continue;
    }
    const oldSha256 = await hashFile(oldFile);
    const previousAsset = previousManifest.assets?.find(entry => entry?.name === item.filename);
    if (!previousAsset || previousAsset.sha256 !== oldSha256 || previousAsset.size !== oldStat.size) {
      throw new Error(`Previous package does not match its release manifest: ${item.filename}`);
    }
    const newSha256 = await hashFile(newFile);
    if (newSha256 !== asset.sha256) throw new Error(`Current package changed: ${item.filename}`);
    const patchName = `patch-${fromTag}-to-${targetTag}-${item.id}.patch`;
    if (!safeRelativeName(patchName)) throw new Error('Patch file name is invalid');
    const patchFile = path.join(releaseDir, patchName);
    await fs.rm(patchFile, { force: true });
    try {
      await runBsdiff(bsdiffPath, oldFile, newFile, patchFile);
      const patchStat = await fs.stat(patchFile);
      if (!patchStat.isFile() || patchStat.size <= 0) throw new Error(`Patch was not created: ${patchName}`);
      if (patchStat.size > asset.size * maxRatio) {
        log(`Skipping ${fromTag} -> ${targetTag} ${item.id}: patch is ${(patchStat.size / asset.size * 100).toFixed(1)}%`);
        await fs.rm(patchFile, { force: true });
        continue;
      }
      const patchSha256 = await hashFile(patchFile);
      const temporary = path.join(os.tmpdir(), `melody-patch-verify-${process.pid}-${fromTag}-${item.id}`);
      try {
        await applyPatch({
          oldPath: oldFile, patchData: await fs.readFile(patchFile), destPath: temporary,
          expectedSize: asset.size, expectedSha256: asset.sha256
        });
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => {});
      }
      patches.push({
        target: item.id, platform: item.platform, arch: item.arch,
        asset: item.filename, fromSha256: oldSha256, toSha256: asset.sha256, toSize: asset.size,
        name: patchName, size: patchStat.size, sha256: patchSha256
      });
      log(`Patch ${fromTag} -> ${targetTag} ${item.id}: ${patchStat.size} bytes (${(patchStat.size / asset.size * 100).toFixed(2)}%)`);
    } catch (error) {
      await fs.rm(patchFile, { force: true }).catch(() => {});
      throw new Error(`Patch generation failed for ${fromTag} -> ${targetTag} ${item.id}: ${error.message}`, { cause: error });
    }
  }
  return patches.length ? { from: fromTag, patches } : null;
}

async function buildPatches({
  releaseDir, previousDir, previousReleases, fromTag, bsdiffPath,
  maxRatio = DEFAULT_MAX_RATIO, runBsdiff = defaultRunBsdiff,
  applyPatch = applyDeltaPatch, log = console.log
} = {}) {
  if (!safeRelativeName(path.basename(releaseDir ?? '')) || !safeRelativeName(path.basename(bsdiffPath ?? ''))) {
    throw new Error('Patch directories or bsdiff executable are invalid');
  }
  const releaseManifest = JSON.parse(await fs.readFile(path.join(releaseDir, 'release-manifest.json'), 'utf8'));
  const targetTag = normalizeTag(releaseManifest?.tag);
  if (!targetTag) throw new Error('Current release tag is invalid');
  if (!Number.isFinite(maxRatio) || maxRatio <= 0 || maxRatio > MAX_PATCH_RATIO) {
    throw new Error('Patch size ratio is invalid');
  }
  let releases = previousReleases;
  if (!Array.isArray(releases)) {
    if (fromTag && previousDir) releases = [{ tag: normalizeTag(fromTag), directory: previousDir }];
    else if (previousDir) releases = await discoverPreviousReleases(previousDir, targetTag);
    else releases = [];
  }
  releases = releases.map((release) => {
    const tag = normalizeTag(release?.tag);
    if (!tag || !safeRelativeName(path.basename(release?.directory ?? ''))) {
      throw new Error('Previous release entry is invalid');
    }
    return { tag, directory: release.directory };
  }).sort((left, right) => compareTagsDescending(left.tag, right.tag)).slice(0, MAX_SOURCES);
  const sources = [];
  for (const previous of releases) {
    if (previous.tag === targetTag) continue;
    const source = await generateSource({
      releaseDir, previous: previous.directory, fromTag: previous.tag, targetTag,
      bsdiffPath, maxRatio, runBsdiff, applyPatch, log
    });
    if (source) sources.push(source);
  }
  if (!sources.length) {
    await fs.rm(path.join(releaseDir, PATCH_MANIFEST_NAME), { force: true }).catch(() => {});
    await fs.rm(path.join(releaseDir, `${PATCH_MANIFEST_NAME}.sha256`), { force: true }).catch(() => {});
    log('No patch met the size budget; the release will use full downloads only.');
    return null;
  }
  const manifest = {
    schemaVersion: 1, from: sources[0].from, to: targetTag,
    tool: { bsdiff: 'zig-bsdiff', bsdiffVersion: process.env.ZIG_BSDIFF_VERSION ?? '0.1.26', apply: 'binpatch', applyVersion: '0.4.2' },
    patches: sources[0].patches,
    sources
  };
  readPatchManifest(manifest, { currentTag: sources[0].from, targetTag });
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  await fs.writeFile(path.join(releaseDir, PATCH_MANIFEST_NAME), text);
  await fs.writeFile(path.join(releaseDir, `${PATCH_MANIFEST_NAME}.sha256`),
    `${await hashFile(path.join(releaseDir, PATCH_MANIFEST_NAME))}  ${PATCH_MANIFEST_NAME}\n`);
  return manifest;
}

if (require.main === module) {
  const [releaseDir, previousDir, fromTag] = process.argv.slice(2);
  buildPatches({ releaseDir, previousDir, fromTag, bsdiffPath: process.env.ZIG_BSDIFF })
    .then(manifest => console.log(manifest
      ? `Generated ${manifest.sources.length} source(s), ${manifest.sources.reduce((sum, source) => sum + source.patches.length, 0)} verified patches for ${manifest.to}`
      : 'No patches generated.'))
    .catch(error => { console.error(error); process.exitCode = 1; });
}

module.exports = { DEFAULT_MAX_RATIO, PATCH_MANIFEST_NAME, buildPatches, defaultRunBsdiff, discoverPreviousReleases };
