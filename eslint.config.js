module.exports = [
  {
    files: ['**/*.{js,cjs,mjs}'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs' },
    rules: {
      'no-unused-vars': ['error', {
        args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_',
        caughtErrors: 'none', ignoreRestSiblings: true
      }],
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-unreachable': 'error',
      'no-dupe-args': 'error',
      'no-dupe-keys': 'error',
      'no-func-assign': 'error',
      'no-self-assign': 'error',
      'valid-typeof': 'error',
      'constructor-super': 'error',
      'no-async-promise-executor': 'error',
      'use-isnan': 'error',
      'no-unsafe-finally': 'error',
      'no-unexpected-multiline': 'error'
    }
  },
  { files: ['**/*.mjs'], languageOptions: { sourceType: 'module' } }
];
