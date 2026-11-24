const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { sourceFiles, evaluateCoverage } = require('../scripts/test-coverage.cjs');
const coverageReporter = require('../scripts/coverage-reporter.cjs');

const root = path.resolve(__dirname, '..');
const groups = { risk: { include: 'src/risk/*.js', lines: 80, branches: 75, functions: 80 } };
const expected = { risk: ['src/risk/a.js', 'src/risk/b.js'] };

function entry(name, total = 100, covered = 100) {
  return { path: path.join(root, 'src/risk', name),
    totalLineCount: total, coveredLineCount: covered,
    totalBranchCount: total, coveredBranchCount: covered,
    totalFunctionCount: total, coveredFunctionCount: covered };
}

test('coverage gate weights counters instead of averaging file percentages', () => {
  const report = evaluateCoverage({ files: [entry('a.js', 900, 900), entry('b.js', 100, 0)] }, expected, groups);
  assert.equal(report.groups[0].lines.percent, 90);
  assert.deepEqual(report.failures, ['src/risk/b.js: source was never exercised']);
});

test('missing reports and new untested files cannot silently pass a coverage gate', () => {
  assert.throws(() => evaluateCoverage(null, expected, groups), /Missing Node test coverage/);
  const report = evaluateCoverage({ files: [entry('a.js')] }, expected, groups);
  assert.ok(report.failures.some(failure => failure.includes('b.js: source was never included')));
  const empty = evaluateCoverage({ files: [] }, { risk: [] }, groups);
  assert.ok(empty.failures.some(failure => failure.includes('no source files matched')));
});

test('each metric is gated before display rounding and malformed counters fail', () => {
  const report = evaluateCoverage({ files: [entry('a.js', 100000, 79999), entry('b.js', 100000, 79999)] }, expected, groups);
  assert.deepEqual(report.failures.map(failure => failure.split(':')[0]), ['risk lines', 'risk functions']);
  const broken = entry('a.js');
  broken.coveredBranchCount = 101;
  assert.throws(() => evaluateCoverage({ files: [broken, entry('b.js')] }, expected, groups), /Invalid branches coverage/);
});

test('coverage gate discovers newly added JavaScript files independently of reports', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'melody-coverage-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'src/risk'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'src/risk/new.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(directory, 'src/risk/data.json'), '{}');
  assert.deepEqual(sourceFiles(directory, groups), { risk: ['src/risk/new.js'] });
});

test('coverage JSON preserves uncovered line details without mixing test progress into the report', async () => {
  const summary = { files: [{ ...entry('a.js'), lines: [{ line: 7, count: 0 }] }] };
  const events = [
    { type: 'test:pass', data: { name: 'fixture' } },
    { type: 'test:coverage', data: { summary } },
    { type: 'test:summary', data: { success: true } }
  ];
  let output = '';
  for await (const chunk of coverageReporter(events)) output += chunk;
  assert.deepEqual(JSON.parse(output), summary);
});
