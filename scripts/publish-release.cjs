'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { hashFile, verifyManifest, assertTag, checksumLines } = require('./release-assets.cjs');
const exec = promisify(execFile);

async function verifyPublicationFiles(directory, manifest) {
  const expected = ['release-manifest.json', 'SHA256SUMS', ...manifest.assets.flatMap(asset => [asset.name, `${asset.name}.sha256`])].sort();
  if (JSON.stringify((await fs.readdir(directory)).sort()) !== JSON.stringify(expected)) throw new Error('Publication directory contains missing or unexpected files');
  for (const asset of manifest.assets) {
    if (await fs.readFile(path.join(directory, `${asset.name}.sha256`), 'utf8') !== `${asset.sha256}  ${asset.name}\n`) throw new Error(`Invalid checksum sidecar: ${asset.name}`);
  }
  const sums = checksumLines(manifest.assets);
  if (await fs.readFile(path.join(directory, 'SHA256SUMS'), 'utf8') !== sums) throw new Error('Invalid SHA256SUMS');
}

async function gh(args) {
  const result = await exec('gh', args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return result.stdout;
}

async function assertSameAssets(local, remote) {
  const expected = (await fs.readdir(local)).sort();
  const actual = (await fs.readdir(remote)).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('Published release asset set is immutable; use a new version');
  for (const name of expected) {
    if (await hashFile(path.join(local, name)) !== await hashFile(path.join(remote, name))) throw new Error(`Published release asset is immutable: ${name}; use a new version`);
  }
}

async function publishRelease(directory, tag, repository, run = gh) {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'release-manifest.json'), 'utf8'));
  assertTag(tag, manifest.version);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '')) throw new Error('Invalid GitHub repository');
  await verifyManifest(directory, manifest);
  await verifyPublicationFiles(directory, manifest);
  const taggedCommit = (await run(['api', `repos/${repository}/commits/${tag}`, '--jq', '.sha'])).trim();
  if (taggedCommit !== manifest.commit) throw new Error('Remote release tag does not point to the verified source commit');
  let existing;
  try { existing = JSON.parse(await run(['api', `repos/${repository}/releases/tags/${tag}`])); }
  catch (error) { if (!/HTTP 404/.test(error.stderr || error.message)) throw error; }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-release-verify-'));
  try {
    if (existing && !existing.draft) {
      await run(['release', 'download', tag, '--repo', repository, '--dir', temporary]);
      await assertSameAssets(directory, temporary);
      return { reused: true };
    }
    if (!existing) {
      const notes = path.resolve(__dirname, `../.github/notes/${tag}.md`);
      const hasNotes = await fs.stat(notes).then(stat => stat.isFile(), () => false);
      await run(['release', 'create', tag, '--repo', repository, '--verify-tag', '--draft', ...(hasNotes ? ['--notes-file', notes] : ['--generate-notes'])]);
    }
    // Only drafts may be repaired. Published tags never reach this overwrite path.
    const files = (await fs.readdir(directory)).sort();
    await run(['release', 'upload', tag, '--repo', repository, '--clobber', ...files.map(name => path.join(directory, name))]);
    await run(['release', 'download', tag, '--repo', repository, '--dir', temporary]);
    await assertSameAssets(directory, temporary);
    await run(['release', 'edit', tag, '--repo', repository, '--draft=false']);
    return { reused: false };
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

if (require.main === module) publishRelease(process.argv[2], process.env.RELEASE_TAG, process.env.GH_REPO || process.env.GITHUB_REPOSITORY)
  .then(result => console.log(result.reused ? 'Published release already matches; no assets changed.' : 'Complete verified release published.'))
  .catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { publishRelease, assertSameAssets, verifyPublicationFiles };
