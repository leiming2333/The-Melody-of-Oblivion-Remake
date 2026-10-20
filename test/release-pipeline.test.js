const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { targets, matrix } = require('../scripts/release-targets.cjs');
const { versions, assertToolchain } = require('../scripts/toolchain.cjs');
const { selectTarget } = require('../scripts/build.cjs');
const { hashFile, prepareRelease, collectPackages, verifyManifest } = require('../scripts/release-assets.cjs');
const { publishRelease } = require('../scripts/publish-release.cjs');
const version = require('../package.json').version;
const commit = 'a'.repeat(40);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-release-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'input');
  const smoke = path.join(root, 'smoke');
  const output = path.join(root, 'output');
  await fs.mkdir(smoke, { recursive: true });
  const lockSha256 = await hashFile(path.join(__dirname, '../package-lock.json'));
  for (const target of targets) {
    const directory = path.join(input, target.id);
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, target.filename);
    const contents = Buffer.from(`package-${target.id}`);
    await fs.writeFile(file, contents);
    await fs.writeFile(path.join(directory, 'build-metadata.json'), JSON.stringify({
      target: target.id, version, commit, sourceDirty: false, lockSha256, toolchain: versions, filename: target.filename, size: contents.length, sha256: await hashFile(file)
    }));
    if (target.smokeRunner) await fs.writeFile(path.join(smoke, `smoke-${target.id}.json`), JSON.stringify({
      ok: true, packaged: true, platform: target.platform, arch: target.arch, version,
      artifact: target.filename, artifactSha256: await hashFile(file)
    }));
    if (target.smokeRunner) await fs.writeFile(path.join(smoke, `upgrade-${target.id}.json`), JSON.stringify({
      ok: true, target: target.id, version, artifact: target.filename, artifactSha256: await hashFile(file),
      upgrades: 2, previousBackupPreserved: true, olderManagedBackupCleaned: true,
      previousVersion: '0.0.0', previousReport: { ok: true, packaged: true, version: '0.0.0', arch: target.arch, platform: target.platform }
    }));
  }
  const prepare = () => prepareRelease(input, output, { tag: `v${version}`, version, commit, smokeDirectory: smoke });
  return { root, input, output, smoke, prepare };
}

test('all eight targets share one definition, with seven native runtime gates', () => {
  assert.equal(matrix().include.length, 8);
  assert.equal(matrix(true).include.length, 7);
  assert.equal(targets.find(target => !target.smokeRunner).id, 'linux-armv7l');
  assert.equal(selectTarget(['--win', '--ia32']).id, 'windows-ia32');
  assert.equal(selectTarget(['--target', 'macos-arm64']).arch, 'arm64');
  assert.throws(() => selectTarget(['--publish', 'always']), /Unsupported/);
  assert.throws(() => selectTarget(['--target', '../outside']), /Unsupported/);
  const fixture = selectTarget(['--target', 'windows-x64', '--upgrade-fixture']);
  assert.equal(fixture.fixtureVersion, '0.0.0');
  assert.equal(fixture.output, 'release/upgrade-fixtures/windows-x64');
  assert.notEqual(fixture.output, targets[0].output);
});

test('manual builds assemble the same verified bundle that tagged releases publish', async () => {
  const yaml = require('js-yaml');
  const workflow = yaml.load(await fs.readFile(path.join(__dirname, '../.github/workflows/build.yml'), 'utf8'));
  assert.deepEqual(workflow.jobs.assemble.needs, ['build', 'smoke']);
  assert.equal(workflow.jobs.assemble.if, undefined);
  assert.equal(workflow.jobs.release.needs, 'assemble');
  const upload = workflow.jobs.assemble.steps.find(step => step.uses?.startsWith('actions/upload-artifact'));
  const download = workflow.jobs.release.steps.find(step => step.uses?.startsWith('actions/download-artifact'));
  assert.equal(upload.with.name, download.with.name);
  assert.equal(upload.with.name, 'verified-release-bundle');
});

test('build preflight rejects toolchain drift and dependencies without integrity', () => {
  const lock = structuredClone(require('../package-lock.json'));
  assert.doesNotThrow(() => assertToolchain({ node: versions.node, userAgent: `npm/${versions.npm}`, lock }));
  assert.throws(() => assertToolchain({ node: '22.0.0', userAgent: `npm/${versions.npm}`, lock }), /requires Node/);
  delete lock.packages['node_modules/electron-builder'].integrity;
  assert.throws(() => assertToolchain({ node: versions.node, userAgent: `npm/${versions.npm}`, lock }), /integrity/);
});

test('release creates portable checksums and binds seven native reports to the exact eight packages', async t => {
  const f = await fixture(t);
  const manifest = await f.prepare();
  assert.equal(manifest.assets.length, 8);
  assert.equal(manifest.assets.filter(asset => asset.smoke.status === 'passed').length, 7);
  assert.equal((await verifyManifest(f.output, manifest)).length, 8);
  const sums = await fs.readFile(path.join(f.output, 'SHA256SUMS'), 'utf8');
  assert.equal(sums.trim().split('\n').length, 8);
  assert.ok(!sums.includes(f.root));
  for (const asset of manifest.assets) assert.equal(await fs.readFile(path.join(f.output, `${asset.name}.sha256`), 'utf8'), `${asset.sha256}  ${asset.name}\n`);
  await fs.appendFile(path.join(f.output, manifest.assets[0].name), 'tamper');
  await assert.rejects(verifyManifest(f.output, manifest), /mismatch/);
});

test('wrong embedded version, package hash, missing target and tag mismatch fail before publishing', async t => {
  const f = await fixture(t);
  const reportPath = path.join(f.smoke, `smoke-${targets[0].id}.json`);
  const report = JSON.parse(await fs.readFile(reportPath));
  await fs.writeFile(reportPath, JSON.stringify({ ...report, version: '0.0.0' }));
  await assert.rejects(f.prepare(), /Smoke report mismatch/);
  await fs.writeFile(reportPath, JSON.stringify({ ...report, artifactSha256: 'f'.repeat(64) }));
  await assert.rejects(f.prepare(), /Smoke report mismatch/);
  await assert.rejects(prepareRelease(f.input, f.output, { tag: 'v0.0.0', version, commit, smokeDirectory: f.smoke }), /tag/);
  await fs.rm(path.join(f.input, targets[0].id, targets[0].filename));
  await assert.rejects(collectPackages(f.input), /Expected 8/);
  await assert.rejects(fs.access(f.output));
});

test('published release retries are read-only and reject changed bytes before any mutation', async t => {
  const f = await fixture(t);
  await f.prepare();
  const remote = path.join(f.root, 'remote');
  await fs.cp(f.output, remote, { recursive: true });
  const commands = [];
  const gh = async args => {
    commands.push(args);
    if (args[0] === 'api') return args[1].includes('/commits/') ? `${commit}\n` : JSON.stringify({ draft: false });
    if (args[1] === 'download') { await fs.cp(remote, args[args.indexOf('--dir') + 1], { recursive: true }); return ''; }
    throw new Error('Unexpected mutation');
  };
  assert.equal((await publishRelease(f.output, `v${version}`, 'owner/repo', gh)).reused, true);
  await fs.appendFile(path.join(remote, targets[0].filename), 'different');
  await assert.rejects(publishRelease(f.output, `v${version}`, 'owner/repo', gh), /immutable/);
  assert.ok(commands.every(args => args[0] === 'api' || args[1] === 'download'));
});

test('publication rejects a moved or unrelated tag before creating or changing a release', async t => {
  const f = await fixture(t);
  await f.prepare();
  const commands = [];
  const gh = async args => { commands.push(args); return 'b'.repeat(40); };
  await assert.rejects(publishRelease(f.output, `v${version}`, 'owner/repo', gh), /source commit/);
  assert.equal(commands.length, 1);
  assert.equal(commands[0][0], 'api');
  assert.match(commands[0][1], /\/commits\//);
});

test('Blob latest only changes after all eight remote package digests are verified', async t => {
  const { syncRelease } = await import('../scripts/sync-release-to-blob.mjs');
  const f = await fixture(t);
  await f.prepare();
  const metadataPath = path.join(f.output, 'release.json');
  await fs.writeFile(metadataPath, JSON.stringify({ tagName: `v${version}`, name: 'test' }));
  const blobs = new Map();
  let fail = true;
  const options = {
    token: 'fixture',
    listBlobs: async ({ prefix }) => ({ blobs: [...blobs.keys()].filter(key => key.startsWith(prefix)).map(pathname => ({ pathname, url: `https://blob.invalid/${pathname}` })) }),
    putBlob: async (pathname, contents) => { blobs.set(pathname, Buffer.from(contents)); return { url: `https://blob.invalid/${pathname}` }; },
    fetchUrl: async url => {
      const key = url.slice('https://blob.invalid/'.length);
      const contents = blobs.get(key);
      return new Response(fail && key.endsWith(targets[2].filename) ? 'corrupt' : contents, { status: contents ? 200 : 404 });
    }
  };
  await assert.rejects(syncRelease(f.output, `v${version}`, metadataPath, options), /digest mismatch/);
  assert.equal(blobs.has('releases/latest.json'), false);
  fail = false;
  assert.equal((await syncRelease(f.output, `v${version}`, metadataPath, options)).latestUpdated, true);
  assert.equal(JSON.parse(blobs.get('releases/latest.json')).assets.length, 8);
  blobs.set('releases/latest.json', Buffer.from(JSON.stringify({ tag_name: 'v999.0.0' })));
  assert.equal((await syncRelease(f.output, `v${version}`, metadataPath, options)).latestUpdated, false);
  assert.equal(JSON.parse(blobs.get('releases/latest.json')).tag_name, 'v999.0.0');
  const immutableKey = `releases/v${version}/manifest.json`;
  const conflicting = JSON.parse(blobs.get(immutableKey));
  conflicting.commit = 'b'.repeat(40);
  blobs.set(immutableKey, Buffer.from(JSON.stringify(conflicting)));
  await assert.rejects(syncRelease(f.output, `v${version}`, metadataPath, options), /immutable/);
  assert.equal(JSON.parse(blobs.get('releases/latest.json')).tag_name, 'v999.0.0');
});
