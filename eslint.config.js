// Shared ESLint flat config for /edge and /frontend. Each package's own
// eslint.config.js imports and extends this once it adds real source and the
// eslint/typescript-eslint dependencies (tracked in later scaffolding issues).
//
// ponytail: kept dependency-free at the repo root so it can exist before any
// package installs eslint. Wire it into a package's real "lint" script when
// that package gets its first source file.
export default [
  {
    ignores: ['dist/**', 'node_modules/**', '.wrangler/**'],
  },
  {
    rules: {
      'no-unused-vars': 'warn',
      'no-undef': 'error',
    },
  },
];
