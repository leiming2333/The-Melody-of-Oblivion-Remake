'use strict';
const fs = require('node:fs');
const { matrix } = require('./release-targets.cjs');
const build = JSON.stringify(matrix());
const smoke = JSON.stringify(matrix(true));
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `build=${build}\nsmoke=${smoke}\n`);
else console.log(JSON.stringify({ build: JSON.parse(build), smoke: JSON.parse(smoke) }));
