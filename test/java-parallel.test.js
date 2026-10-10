const test = require('node:test');
const assert = require('node:assert/strict');
const { detectJava } = require('../src/main/minecraft/java-runtime');

test('a rejected Java candidate does not hide other valid runtimes', async () => {
  const started = [];
  const result = await detectJava(undefined, async (candidate) => {
    started.push(candidate);
    if (candidate === 'broken') throw new Error('probe failed');
    return candidate === 'java25' ? 25 : 8;
  }, async () => ['broken', 'java8', 'java25']);
  assert.deepEqual(started, ['broken', 'java8', 'java25']);
  assert.equal(result.path, 'java25');
});
