import tseslint from 'typescript-eslint';
import base from '../eslint.config.js';

// Extends the shared root config (see /eslint.config.js) with TypeScript-aware
// parsing and rules, now that /edge has real source to lint.
export default tseslint.config(
  { ignores: ['worker-configuration.d.ts'] },
  ...base,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
