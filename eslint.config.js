import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default defineConfig(
  // .claude/ holds local worktrees of this same repo; each lints itself.
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '.claude/**'] },

  js.configs.recommended,

  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        // Each file is checked against the nearest tsconfig.json.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Project rule: no `any`, anywhere.
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },

  {
    files: ['apps/web/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
  },

  {
    // The engine's src/ must stay pure: same input, same output.
    // Its tsconfig already hides Node and the DOM; these close the gaps that
    // plain JavaScript leaves open.
    files: ['packages/engine/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*'],
              message: 'Engine src must not do I/O. Node built-ins belong in cli/ or the server.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'Date', message: 'Engine src has no clock. Pass time in if you need it.' },
        // The global object is a back door to everything the tsconfig hides:
        // a cast like (globalThis as { crypto: ... }) would compile.
        ...['globalThis', 'window', 'self', 'global'].map((name) => ({
          name,
          message: 'Engine src must not reach for the global object.',
        })),
        ...[
          'console',
          'crypto',
          'document',
          'fetch',
          'localStorage',
          'navigator',
          'performance',
          'process',
          'setInterval',
          'setTimeout',
        ].map((name) => ({ name, message: 'Engine src must not do I/O.' })),
        // Two more ways to a clock or to the global object.
        { name: 'eval', message: 'Engine src must not run code from text.' },
        { name: 'Intl', message: 'Engine src has no clock or locale. Format on the outside.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression',
          message: 'Engine src must not load code at run time. Use a normal import.',
        },
      ],
      // A `/// <reference lib="dom" />` in one file would bring browser types
      // into the whole engine and switch the compile-time guard off.
      '@typescript-eslint/triple-slash-reference': [
        'error',
        { lib: 'never', path: 'never', types: 'never' },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'Engine src takes randomness as input. Never call Math.random.',
        },
      ],
    },
  },
);
