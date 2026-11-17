const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { zip: installerZip } = require('./helpers/zip-fixture');
const { readArchiveJsonEntries } = require('../src/main/minecraft/modpack-archive');

async function archiveFixture(t, bytes) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-installer-archive-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archivePath = path.join(root, 'installer.jar');
  await fs.writeFile(archivePath, bytes);
  return { root, archivePath };
}

for (const method of [0, 8]) {
  test(`installer manifests are read from ${method === 0 ? 'stored' : 'deflated'} JAR entries without extraction`, async (t) => {
    const installProfile = { spec: 1, libraries: [{ name: 'net.example:processor:1.0' }] };
    const version = { id: '1.20.1-forge-47.3.22', inheritsFrom: '1.20.1' };
    const { root, archivePath } = await archiveFixture(t, installerZip([
      ['install_profile.json', JSON.stringify(installProfile), method],
      ['version.json', JSON.stringify(version), method],
      ['maven/embedded.jar', 'not JSON and larger than the selected manifest budget'.repeat(100), method]
    ]));
    assert.deepEqual(await readArchiveJsonEntries(archivePath, ['install_profile.json', 'version.json'], {
      maximumBytes: 256
    }), { 'install_profile.json': installProfile, 'version.json': version });
    assert.deepEqual(await fs.readdir(root), ['installer.jar']);
  });
}

test('legacy installers can omit version.json and missing entries are absent', async (t) => {
  const legacy = { install: { version: '1.7.10-Forge10.13.4.1614-1.7.10' }, versionInfo: { libraries: [] } };
  const { archivePath } = await archiveFixture(t, installerZip([
    ['install_profile.json', JSON.stringify(legacy)]
  ]));
  const result = await readArchiveJsonEntries(archivePath, ['install_profile.json', 'version.json']);
  assert.deepEqual(result, { 'install_profile.json': legacy });
  assert.equal(Object.hasOwn(result, 'version.json'), false);
});

test('broken installer JSON reports its entry name', async (t) => {
  const { archivePath } = await archiveFixture(t, installerZip([['install_profile.json', '{broken']]));
  await assert.rejects(readArchiveJsonEntries(archivePath, ['install_profile.json']), /JSON 条目已损坏：install_profile.json/);
});

test('broken installer ZIPs fail before returning partial manifest data', async (t) => {
  const bytes = installerZip([['install_profile.json', '{}']]);
  bytes.writeUInt32LE(0, 0);
  const { archivePath } = await archiveFixture(t, bytes);
  await assert.rejects(readArchiveJsonEntries(archivePath, ['install_profile.json']), /已损坏/);
  await fs.writeFile(archivePath, bytes.subarray(0, 16));
  await assert.rejects(readArchiveJsonEntries(archivePath, ['install_profile.json']), /已损坏/);
});

test('installer JSON budgets limit inflated bytes and the total across selected entries', async (t) => {
  const { archivePath } = await archiveFixture(t, installerZip([
    ['install_profile.json', JSON.stringify({ padding: 'a'.repeat(5000) }), 8]
  ]));
  await assert.rejects(readArchiveJsonEntries(archivePath, ['install_profile.json'], {
    maximumBytes: 100
  }), /JSON 条目过大：install_profile.json/);
  await fs.writeFile(archivePath, installerZip([
    ['install_profile.json', '{"one":1}'], ['version.json', '{"two":2}']
  ]));
  await assert.rejects(readArchiveJsonEntries(archivePath, ['install_profile.json', 'version.json'], {
    maximumBytes: 12
  }), /JSON 条目过大：version.json/);
});

test('installer JSON budgets also reject oversized compressed entries', async (t) => {
  const bytes = installerZip([['install_profile.json', '{}', 8]]);
  const directoryOffset = bytes.readUInt32LE(bytes.length - 6);
  bytes.writeUInt32LE(1000, directoryOffset + 20);
  const { archivePath } = await archiveFixture(t, bytes);
  await assert.rejects(readArchiveJsonEntries(archivePath, ['install_profile.json'], {
    maximumBytes: 100
  }), /JSON 条目过大：install_profile.json/);
});

for (const entries of [
  [['../install_profile.json', '{}']],
  [['install_profile.json', '{}'], ['INSTALL_PROFILE.JSON', '{}']]
]) {
  test(`installer JSON reading preserves archive path validation for ${entries[0][0]}`, async (t) => {
    const { archivePath } = await archiveFixture(t, installerZip(entries));
    await assert.rejects(readArchiveJsonEntries(archivePath, ['install_profile.json']), /不安全|重复/);
  });
}

test('installer JSON reading respects cancellation before opening an archive', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readArchiveJsonEntries('does-not-exist.jar', ['install_profile.json'], {
    signal: controller.signal
  }), { name: 'AbortError' });
});
