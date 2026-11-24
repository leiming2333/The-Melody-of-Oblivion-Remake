'use strict';

const versions = Object.freeze({ node: '26.10.0', npm: '11.13.0', electron: '43.4.1', builder: '26.15.3' });

function npmUserAgent() {
  if (process.env.npm_execpath) {
    const path = require('node:path');
    const fs = require('node:fs');
    const pkg = JSON.parse(fs.readFileSync(path.resolve(path.dirname(process.env.npm_execpath), '../package.json'), 'utf8'));
    if (pkg.name === 'npm') return `npm/${pkg.version}`;
  }
  return process.env.npm_config_user_agent || '';
}

function assertToolchain({ node = process.versions.node, userAgent = npmUserAgent(), lock = require('../package-lock.json'), development = false } = {}) {
  const npm = /^npm\/([^ ]+)/.exec(userAgent)?.[1];
  const nodeMajor = /^(\d+)\.\d+\.\d+$/.exec(node)?.[1];
  const npmMajor = /^(\d+)\.\d+\.\d+$/.exec(npm ?? '')?.[1];
  if (development && (!nodeMajor || Number(nodeMajor) < 24 || Number(nodeMajor) >= 27 || npmMajor !== '11')) {
    throw new Error(`Development requires Node >=24 <27 and npm >=11 <12; received Node ${node}, npm ${npm || 'unknown'}. Run through npm.`);
  }
  if (!development && (node !== versions.node || npm !== versions.npm)) {
    throw new Error(`Build requires Node ${versions.node} and npm ${versions.npm}; received Node ${node}, npm ${npm || 'unknown'}. Run through the pinned npm version.`);
  }
  for (const [name, expected] of [['electron', versions.electron], ['electron-builder', versions.builder]]) {
    if (lock.packages[`node_modules/${name}`]?.version !== expected) throw new Error(`Unexpected locked ${name} version`);
  }
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (!name || entry.link) continue;
    if (!entry.integrity || !/^https:\/\/registry\.npmjs\.org\//.test(entry.resolved || '')) {
      throw new Error(`Missing official registry integrity metadata: ${name}`);
    }
  }
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.some(argument => argument !== '--development')) throw new Error('Supported toolchain option: --development');
    const development = args.includes('--development');
    assertToolchain({ development });
    console.log(JSON.stringify({ mode: development ? 'development' : 'release', ...versions }));
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { versions, assertToolchain };
