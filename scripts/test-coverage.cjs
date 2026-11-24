'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const thresholds = require('./coverage-thresholds.json');

const root = path.resolve(__dirname, '..');
const metrics = { lines: 'Line', branches: 'Branch', functions: 'Function' };
const posix = value => value.split(path.sep).join('/');

function sourceFiles(directory, groups = thresholds) {
  return Object.fromEntries(Object.entries(groups).map(([name, group]) => [name,
    [...fs.globSync(group.include, { cwd: directory })].map(posix).sort()
  ]));
}

function evaluateCoverage(summary, expectedFiles, groups = thresholds, directory = root) {
  if (!summary || !Array.isArray(summary.files)) throw new Error('Missing Node test coverage summary');
  const files = new Map(summary.files.map(file => [posix(path.relative(directory, file.path)), file]));
  const failures = [];
  const results = [];
  for (const [name, group] of Object.entries(groups)) {
    const expected = expectedFiles[name] ?? [];
    if (!expected.length) failures.push(`${name}: no source files matched ${group.include}`);
    const selected = [];
    for (const relative of expected) {
      const file = files.get(relative);
      if (!file) failures.push(`${relative}: source was never included in the coverage report`);
      else {
        selected.push(file);
        if (file.coveredLineCount === 0) failures.push(`${relative}: source was never exercised`);
      }
    }
    const result = { name, files: expected, thresholds: group };
    for (const [label, metric] of Object.entries(metrics)) {
      let covered = 0;
      let total = 0;
      for (const file of selected) {
        const fileTotal = file[`total${metric}Count`];
        const fileCovered = file[`covered${metric}Count`];
        if (!Number.isSafeInteger(fileTotal) || !Number.isSafeInteger(fileCovered)
          || fileTotal < 0 || fileCovered < 0 || fileCovered > fileTotal) {
          throw new Error(`Invalid ${label} coverage counters: ${file.path}`);
        }
        covered += fileCovered;
        total += fileTotal;
      }
      const percent = total ? covered / total * 100 : 0;
      result[label] = { covered, total, percent };
      if (percent < group[label]) {
        failures.push(`${name} ${label}: ${percent.toFixed(2)}% is below ${group[label]}%`);
      }
    }
    results.push(result);
  }
  return { groups: results, failures };
}

function markdownReport(report, summary) {
  const lines = [
    '# High-risk source coverage', '',
    '| Group | Files | Lines | Branches | Functions |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...report.groups.map(group => `| ${group.name} | ${group.files.length} | ${Object.keys(metrics)
      .map(metric => `${group[metric].percent.toFixed(2)}% (minimum ${group.thresholds[metric]}%)`).join(' | ')} |`),
    '', '## Files', '', '| Source | Lines | Branches | Functions |', '| --- | ---: | ---: | ---: |',
    ...summary.files.map(file => `| ${posix(path.relative(root, file.path))} | ${Object.values(metrics)
      .map(metric => `${file[`covered${metric}Percent`].toFixed(2)}%`).join(' | ')} |`),
    '', ...report.failures.map(failure => `- FAIL: ${failure}`), ''
  ];
  return lines.join('\n');
}

async function main() {
  const output = path.join(root, 'coverage');
  fs.mkdirSync(output, { recursive: true });
  const rawReport = path.join(output, 'raw-summary.json');
  // A crashed test run must never reuse a previous successful summary.
  for (const name of ['raw-summary.json', 'summary.json', 'report.md', 'tests.log']) {
    fs.rmSync(path.join(output, name), { force: true });
  }
  const expected = sourceFiles(root);
  const args = [
    '--test', '--test-concurrency=4', '--experimental-test-coverage',
    ...Object.values(thresholds).map(group => `--test-coverage-include=${group.include}`),
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    `--test-reporter=${pathToFileURL(path.join(__dirname, 'coverage-reporter.cjs')).href}`,
    `--test-reporter-destination=${rawReport}`, 'test/*.test.js'
  ];
  const log = fs.createWriteStream(path.join(output, 'tests.log'));
  const child = spawn(process.execPath, args, { cwd: root, env: process.env, windowsHide: true });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', chunk => { process.stdout.write(chunk); log.write(chunk); });
  }
  const testCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve(signal ? 1 : code ?? 1));
  }).finally(() => log.end());
  if (!fs.existsSync(rawReport) || !fs.statSync(rawReport).size) {
    throw new Error(`No coverage summary was generated (test exit ${testCode})`);
  }
  const summary = JSON.parse(fs.readFileSync(rawReport, 'utf8'));
  const report = evaluateCoverage(summary, expected);
  const markdown = markdownReport(report, summary);
  fs.writeFileSync(path.join(output, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(output, 'report.md'), markdown);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  for (const failure of report.failures) console.error(`Coverage gate failed: ${failure}`);
  console.log(`Coverage reports: ${output}`);
  process.exitCode = testCode || (report.failures.length ? 1 : 0);
}

if (require.main === module) {
  void main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { sourceFiles, evaluateCoverage, markdownReport };
