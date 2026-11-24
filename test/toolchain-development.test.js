const test = require('node:test');
const assert = require('node:assert/strict');
const { versions, assertToolchain } = require('../scripts/toolchain.cjs');
const lock = require('../package-lock.json');

test('development accepts compatible Node and npm while release builds remain pinned', () => {
  for (const node of ['24.0.0', '24.21.0', '25.0.0', '26.10.1']) {
    for (const npm of ['11.0.0', '11.19.0', '11.21.2']) {
      assert.doesNotThrow(() => assertToolchain({ node, userAgent: `npm/${npm}`, lock, development: true }));
      assert.throws(() => assertToolchain({ node, userAgent: `npm/${npm}`, lock }), /Build requires Node/);
    }
  }
  assert.doesNotThrow(() => assertToolchain({ node: versions.node, userAgent: `npm/${versions.npm}`, lock }));
});

test('development rejects unsupported versions, unknown npm, and prereleases', () => {
  for (const node of ['22.0.0', '23.11.0', '27.0.0', '26.0.0-rc.1', 'invalid']) {
    assert.throws(() => assertToolchain({ node, userAgent: 'npm/11.13.0', lock, development: true }), /Development requires Node/);
  }
  for (const userAgent of ['', 'npm/10.9.0', 'npm/12.0.0', 'npm/11.0.0-beta.1', 'pnpm/11.0.0']) {
    assert.throws(() => assertToolchain({ node: '24.21.0', userAgent, lock, development: true }), /Development requires Node/);
  }
});

test('compatible development toolchains still enforce locked versions and dependency integrity', () => {
  const options = { node: '24.21.0', userAgent: 'npm/11.19.0', development: true };
  const altered = structuredClone(lock);
  altered.packages['node_modules/electron'].version = '0.0.0';
  assert.throws(() => assertToolchain({ ...options, lock: altered }), /Unexpected locked electron/);
  altered.packages['node_modules/electron'].version = versions.electron;
  delete altered.packages['node_modules/electron-builder'].integrity;
  assert.throws(() => assertToolchain({ ...options, lock: altered }), /integrity metadata/);
});
