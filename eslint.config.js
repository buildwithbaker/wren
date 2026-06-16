// ESLint 9 flat config for Wren (PWA + Chrome extension, ESM browser code).
//   npm run lint        -> report
//   npm run lint:fix    -> auto-fix what's safe
//
// Baseline is green against the current tree (warnings allowed, no errors).
// New violations stand out.
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'dist/**',
      'dist-extension/**',
      'node_modules/**',
      'src-tauri/**', // Rust crate; target/ holds generated JS assets, not ours
      '**/*.html',
      '**/*.timestamp-*.mjs',
    ],
  },

  js.configs.recommended,

  // Browser app + extension popup source.
  {
    files: ['src/**/*.js', 'extension/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        chrome: 'readonly', // MV3 extension API
      },
    },
  },

  // Service workers (PWA + extension MV3 background).
  {
    files: ['**/sw.js', '**/service-worker.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.serviceworker, chrome: 'readonly' },
    },
  },

  // Node tooling: build scripts and config files.
  {
    files: ['scripts/**/*.{js,mjs}', '*.config.js', '*.config.*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  // Tests run under vitest; smoke test uses the jsdom environment.
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
  },

  // Project-wide rule normalization (applied last so it wins).
  {
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-control-regex': 'off', // intentional control-char stripping in buildNoteFilename
      'prefer-const': 'warn',
      eqeqeq: ['warn', 'smart'],
    },
  },
];
