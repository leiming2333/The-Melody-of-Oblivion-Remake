const path = require('node:path');
const electron = require('electron');
const { verify } = require('./verify-packaged.cjs');

// The verification harness owns the fresh user data and removes it after exit,
// when Chromium no longer holds locks on its files on Windows.
verify(electron, [path.resolve(__dirname, '..')], { requirePackaged: false })
  .catch(error => { console.error(error.message); process.exitCode = 1; });
