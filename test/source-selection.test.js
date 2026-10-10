const test = require('node:test');
const assert = require('node:assert/strict');
const { MinecraftSourceManager } = require('../src/main/minecraft/source-manager');

test('automatic source selection chooses measured throughput, caches it, and rejects cancelled cached requests', async () => {
  const manager = new MinecraftSourceManager();
  let probes = 0;
  manager.benchmarkSource = async (url) => {
    probes++;
    return { bytesPerSecond: url.includes('bmclapi') ? 2000 : 1000 };
  };
  const request = { versionId: '1.21.1', originalUrl: 'https://example.com/client.jar' };
  assert.equal((await manager.selectDownloadSource(request)).id, 'bmclapi');
  assert.equal((await manager.selectDownloadSource(request)).throughput, 2000);
  assert.equal(probes, 2);
  await assert.rejects(manager.selectDownloadSource({ ...request, signal: AbortSignal.abort() }), { name: 'AbortError' });
  manager.setDownloadPreference('official');
  assert.equal((await manager.selectDownloadSource(request)).id, 'official');
  assert.equal(probes, 2);
});

test('one failed speed probe keeps the other source; all failures fall back to reachability', async () => {
  const manager = new MinecraftSourceManager();
  manager.benchmarkSource = async (url) => {
    if (url.includes('bmclapi')) throw new Error('offline');
    return { bytesPerSecond: 1000 };
  };
  const request = { versionId: '1.21.1', originalUrl: 'https://example.com/client.jar' };
  assert.equal((await manager.selectDownloadSource(request)).id, 'official');
  manager.benchmarkSource = async () => { throw new Error('failed'); };
  manager.selectSource = async () => ({ id: 'official', label: 'Mojang 官方' });
  assert.equal((await manager.selectDownloadSource({ ...request, force: true })).benchmarkFailed, true);
});
