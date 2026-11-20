import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**'] },

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
);
