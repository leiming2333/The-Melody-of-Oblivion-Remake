const { ESLint } = require('eslint');

async function check() {
  const eslint = new ESLint();
  // ESLint's parser checks syntax as well as the selected correctness rules.
  const results = await eslint.lintFiles(['site.js', 'src', 'api', 'scripts', 'test', 'eslint.config.js']);
  const formatter = await eslint.loadFormatter('stylish');
  const report = formatter.format(results);
  if (report) process.stdout.write(report);
  if (results.some((result) => result.errorCount > 0)) process.exitCode = 1;
  else console.log(`Syntax and lint checked ${results.length} JavaScript files`);
}

void check().catch((error) => { console.error(error.message); process.exitCode = 1; });
